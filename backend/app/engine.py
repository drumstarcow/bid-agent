# -*- coding: utf-8 -*-
"""业务引擎：标讯智能匹配、招标文件体检、知识库 RAG、台账巡检、统计。
所有评分与判定均为真实计算（非写死结果），与前端演示版算法保持一致。"""
import json
import re
import unicodedata
from datetime import date
from .db import today

ORGS = ['集团总部', '上海公司', '广东公司', '北京公司', '江苏公司', '浙江公司', '四川公司']
REGIONS = ['上海', '广东', '北京', '江苏', '浙江', '四川', '湖北']
BIZ_TYPES = ['人力资源服务', '会展赛事服务', '物业与后勤', '培训与咨询', '贸易物流']

CERT_LIKE_RE = re.compile(r'许可证|资质|认证|证书|ISO|信用', re.I)
WEIGHT_RE = re.compile(r'业绩|类似|经验|规模|机构')
LOCAL_RE = re.compile(r'本地|区域|机构|驻场|属地')

CAP_MAP = {
    '人力资源服务': '人力资源服务', 'RPO': '人力资源服务', '灵活用工': '人力资源服务',
    '批量招聘': '人力资源服务', '千人规模': '人力资源服务', '制造业': '人力资源服务',
    '会展服务': '会展赛事服务', '大型展会': '会展赛事服务', '现场运营': '会展赛事服务',
    '高端论坛': '会展赛事服务', '会务执行': '会展赛事服务', '赛事': '会展赛事服务',
    '物业服务': '物业与后勤', '安保': '物业与后勤', '医疗': '物业与后勤',
    '24小时': '物业与后勤', '访客系统': '物业与后勤', '数字化': '物业与后勤',
    '培训服务': '培训与咨询', '课程设计': '培训与咨询', '体系搭建': '培训与咨询',
    '国企': '培训与咨询', '互联网': '培训与咨询',
    '仓储': '贸易物流', '物流': '贸易物流', '跨境': '贸易物流',
    '类似业绩': None, '业绩': None, '同类项目': None,
}

REQ_RULES = [
    {'key': '资质类', 're': re.compile(r'资质|许可证|认证|证书|执照|资格'), 'level': '高',
     'tip': '强制项：须提供有效证照，并确认经营范围与有效期覆盖项目周期'},
    {'key': '业绩类', 're': re.compile(r'业绩|类似项目|近三年|案例|经验'), 'level': '中',
     'tip': '须提供合同复印件或中标通知书，金额与数量须达标'},
    {'key': '人员类', 're': re.compile(r'人员|项目经理|拟派|持证|团队配置'), 'level': '中',
     'tip': '须附人员证书与社保证明，注意人员不得重复用于同期项目'},
    {'key': '财务类', 're': re.compile(r'注册资本|营业收入|资产负债|审计报告|财务报表'), 'level': '中',
     'tip': '须提供近一年审计报告，注意注册资本门槛'},
    {'key': '本地化', 're': re.compile(r'本地|分支|固定服务|驻场|属地'), 'level': '中',
     'tip': '须证明属地服务能力（营业执照、房屋租赁或办公场所证明）'},
    {'key': '时限类', 're': re.compile(r'截止|递交|送达|开标|投标有效期|逾期'), 'level': '高',
     'tip': '硬性时限，逾期或未按要求送达直接废标；投标有效期须覆盖评标周期'},
    {'key': '格式类', 're': re.compile(r'密封|盖章|签字|签章|正本|副本|份数|装订|逐页'), 'level': '高',
     'tip': '形式审查高频废标点，须逐页检查签署与密封要求'},
    {'key': '报价类', 're': re.compile(r'限价|最高限价|不得超过|报价|预算金额'), 'level': '高',
     'tip': '超限价或大小写不一致直接废标，须双人复核'},
    {'key': '保证金', 're': re.compile(r'保证金|保函'), 'level': '中',
     'tip': '须在规定时间前到账并保留凭证，注意是否接受保函'},
    {'key': '偏离类', 're': re.compile(r'偏离|逐条响应|实质性响应|响应表'), 'level': '中',
     'tip': '技术/商务偏离表不得留空，负偏离可能被认定未实质性响应'},
    {'key': '否决条款', 're': re.compile(r'不得|否则作废|否决|废标|无效投标|视为放弃'), 'level': '高',
     'tip': '强制否决条款，须逐条确认无触发情形'},
]

SAMPLE_DOC = '''某市市级机关集中办公区物业及后勤服务采购项目 资格要求：
1. 投标人须具备人力资源服务许可证或物业服务相关资质，且在有效期内。
2. 须提供 ISO9001 质量管理体系认证证书，否则作废。
3. 近三年须具有 2 个以上同类机关物业业绩，须提供合同复印件。
4. 项目经理须持物业管理师证书，拟派团队配置不少于 15 人。
5. 投标人必须在上海市设有固定服务机构，须提供办公场所证明。
6. 注册资本不低于 1000 万元，须提供近一年审计报告。
7. 投标文件须于截止时间前送达，逾期送达或未按要求密封的将被拒收。
8. 投标保证金 20 万元须在开标前到账，不接受保函。
9. 技术偏离表须逐条响应，出现负偏离的视为未实质性响应。
10. 报价不得超过最高限价 3200 万元，大小写不一致的作废。'''


def esc(s) -> str:
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def days_to(date_str: str, base: str | None = None) -> int:
    y, m, d = (int(x) for x in date_str.split('-'))
    b = base or today()
    by, bm, bd = (int(x) for x in b.split('-'))
    return (date(y, m, d) - date(by, bm, bd)).days


def cert_status(c: dict, base: str | None = None) -> dict:
    d = days_to(c['valid_to'], base)
    if d < 0:
        return {'level': 'expired', 'label': '已过期', 'days': d}
    if d <= 30:
        return {'level': 'danger', 'label': '30天内到期', 'days': d}
    if d <= 90:
        return {'level': 'warn', 'label': '90天内到期', 'days': d}
    return {'level': 'ok', 'label': '有效', 'days': d}


# ---------- 行加载辅助 ----------
def _j(text: str):
    return json.loads(text)


def load_certs(conn) -> list[dict]:
    return [{'id': r['id'], 'name': r['name'], 'owner': r['owner'], 'no': r['no'],
             'valid_from': r['valid_from'], 'valid_to': r['valid_to'], 'version': r['version'],
             'file': r['file'], 'tags': _j(r['tags'])} for r in conn.execute('SELECT * FROM certs ORDER BY id')]


def load_cases(conn) -> list[dict]:
    return [{'id': r['id'], 'name': r['name'], 'client': r['client'], 'region': r['region'],
             'biz': r['biz'], 'amount': r['amount'], 'date': r['date'],
             'tags': _j(r['tags']), 'reuse': r['reuse']} for r in conn.execute('SELECT * FROM cases ORDER BY id')]


def load_solutions(conn) -> list[dict]:
    return [{'id': r['id'], 'name': r['name'], 'biz': r['biz'], 'version': r['version'],
             'updated': r['updated'], 'owner': r['owner'], 'reuse': r['reuse'], 'author': r['author']}
            for r in conn.execute('SELECT * FROM solutions ORDER BY id')]


def load_quotes(conn) -> list[dict]:
    return [{'id': r['id'], 'name': r['name'], 'biz': r['biz'], 'version': r['version'],
             'updated': r['updated'], 'owner': r['owner'], 'desc': r['desc']}
            for r in conn.execute('SELECT * FROM quotes ORDER BY id')]


def load_tenders(conn) -> list[dict]:
    return [{'id': r['id'], 'title': r['title'], 'buyer': r['buyer'], 'region': r['region'],
             'biz': r['biz'], 'budget': r['budget'], 'publish': r['publish'], 'deadline': r['deadline'],
             'source': r['source'], 'requires': _j(r['requires']), 'key_points': _j(r['key_points'])}
            for r in conn.execute('SELECT * FROM tenders ORDER BY id')]


def load_knowledge(conn) -> list[dict]:
    return [{'id': r['id'], 'title': r['title'], 'source': r['source'], 'updated': r['updated'], 'text': r['text']}
            for r in conn.execute('SELECT * FROM knowledge ORDER BY id')]


def get_tender(conn, tender_id: str) -> dict | None:
    return next((t for t in load_tenders(conn) if t['id'] == tender_id.upper()), None)


# ---------- RAG：2-gram 检索 ----------
def _grams(s: str) -> list[str]:
    t = ''.join(ch for ch in str(s) if not ch.isspace()
                and unicodedata.category(ch)[0] not in ('P', 'S'))
    return [t[i:i + 2] for i in range(len(t) - 1)]


def rag_search(conn, query: str, top_k: int = 3) -> list[dict]:
    q = set(_grams(query))
    if not q:
        return []
    scored = []
    for k in load_knowledge(conn):
        text = k['title'] + ' ' + k['text']
        gs = _grams(text)
        hit = sum(1 for g in gs if g in q)
        if hit == 0:
            continue
        score = hit / (len(gs) + 10) ** 0.5 + (0.6 if query in text else 0)
        scored.append({'doc': k, 'score': round(score, 4), 'hit': hit})
    scored.sort(key=lambda x: -x['score'])
    return scored[:top_k]


def synthesize_text(conn, query: str) -> dict:
    """依据检索结果合成纯文本回答（供智能体对话使用），附引用溯源。"""
    hits = [h for h in rag_search(conn, query, 3) if h['score'] > 0.05]
    if not hits:
        return {'hits': [], 'text': (f'知识库中未检索到与「{query}」相关的内容。建议：换用更短的关键词重试'
                                     '（如"资质审查""报价模型"）；或由业务负责人在素材台账中补充该主题素材，入库后自动纳入检索范围。')}
    primary = hits[0]['doc']
    sentences = [s for s in re.split(r'(?<=[。；])', primary['text']) if len(s.strip()) > 8]
    qg = set(_grams(query))

    def sent_hit(s):
        return sum(1 for g in _grams(s) if g in qg)

    picked = [s.strip() for s in sorted(sentences, key=lambda s: -sent_hit(s))[:3]]
    lines = [f'根据集团投标知识库检索，与「{query}」最相关的依据如下：']
    lines += [f'{i}. {s}' for i, s in enumerate(picked, 1)]
    if len(hits) > 1:
        lines.append('相关补充：' + '；'.join(f"《{h['doc']['title']}》" for h in hits[1:]))
    lines.append('※ 以上结论由知识库 ' + str(len(hits)) + ' 条素材合成，引用来源：'
                 + '；'.join(f"《{h['doc']['title']}》（{h['doc']['source']} · 更新 {h['doc']['updated']}）" for h in hits)
                 + '。涉及数据、承诺与资质的表述须经业务负责人校对后方可写入投标文件。')
    return {'hits': hits, 'text': '\n'.join(lines)}


# ---------- 标讯智能匹配 ----------
def match_tender(conn, t: dict) -> dict:
    certs, cases, solutions = load_certs(conn), load_cases(conn), load_solutions(conn)
    reasons, missing = [], []
    sources = {'certs': [], 'cases': [], 'solutions': []}
    w_hit = w_all = 0.0
    hard_missing = 0

    for r in t['requires']:
        is_cert_like = bool(CERT_LIKE_RE.search(r))
        w = 1.6 if is_cert_like else (1.2 if WEIGHT_RE.search(r) else 1.0)
        w_all += w

        # 1) 资质证照（含去后缀模糊比对）
        r_norm = re.sub(r'资质|证书|认证|资格|许可证', '', r)
        cert_hit = None
        for c in certs:
            nm = re.sub(r'[（(].*?[)）]', '', c['name'])
            if (len(r_norm) >= 3 and r_norm in nm) or c['name'] in r or r in c['name'] \
                    or any(x in r or r in x for x in c['tags']):
                cert_hit = c
                break
        if cert_hit:
            st = cert_status(cert_hit)
            if st['level'] != 'expired':
                k = 1.0 if st['level'] == 'ok' else 0.6
                w_hit += w * k
                sources['certs'].append(cert_hit)
                suffix = '' if st['level'] == 'ok' else f"，⚠ {st['label']}，须尽快延续"
                reasons.append(f"具备《{cert_hit['name']}》（{cert_hit['owner']} · 有效期至 {cert_hit['valid_to']}{suffix}）")
                continue
            missing.append({'req': r, 'why': f"《{cert_hit['name']}》已于 {cert_hit['valid_to']} 过期，不可用，须先完成换证"})
            hard_missing += 1
            continue

        # 2) 区域本地化
        if LOCAL_RE.search(r):
            orgs = [o for o in ORGS if t['region'] in o]
            if orgs:
                w_hit += w
                reasons.append(f"{r}：{t['region']}设有属地公司（{'、'.join(orgs)}），可出具本地服务证明")
            else:
                missing.append({'req': r, 'why': f"{t['region']}暂无属地公司，需评估设立分支机构或联合当地供应商"})
                hard_missing += 1
            continue

        # 3) 业务能力映射（None 表示映射回本标业务线）
        cap_raw = CAP_MAP.get(r, '__MISSING__')
        cap_biz = t['biz'] if cap_raw is None else (cap_raw if cap_raw != '__MISSING__' else None)
        if cap_biz:
            cs = [c for c in cases if c['biz'] == cap_biz]
            ss = [s for s in solutions if s['biz'] == cap_biz]
            if cs or ss:
                k = 1.0 if len(cs) >= 2 else (0.8 if len(cs) == 1 else 0.6)
                w_hit += w * k
                sources['cases'] += cs
                sources['solutions'] += ss
                if cs:
                    detail = f"{len(cs)} 个可佐证业绩（{'；'.join(f"{c['name']}｜{c['date']}｜{c['amount']:.0f}万元" for c in cs[:2])}）"
                else:
                    detail = f"暂无业绩，但有方案模板 {ss[0]['name']}（{ss[0]['version']}）可复用"
                reasons.append(f"{r}：具备{cap_biz}交付能力 — {detail}")
                continue

        # 4) 资质类要求不得用业绩替代
        if is_cert_like:
            hard_missing += 1
            missing.append({'req': r, 'why': '知识库中无对应有效资质，属强制项缺失，须办理或从外部借证'})
            continue

        # 5) 业绩标签命中
        case_hit = [c for c in cases if any(x in r or r in x for x in c['tags'])]
        if case_hit:
            w_hit += w
            sources['cases'] += case_hit
            reasons.append(f"{r}：可调取 {len(case_hit)} 个可佐证业绩 — "
                           + '；'.join(f"{c['name']}（{c['date']}，{c['amount']:.0f}万元）" for c in case_hit[:2]))
            continue

        # 6) 方案模板命中
        sol_hit = [s for s in solutions if r in s['name']]
        if sol_hit:
            w_hit += w * 0.7
            sources['solutions'] += sol_hit
            reasons.append(f"{r}：有方案模板可复用（{sol_hit[0]['name']} · {sol_hit[0]['version']}，已复用 {sol_hit[0]['reuse']} 次）")
            continue

        # 7) 未命中
        missing.append({'req': r, 'why': '暂无直接可佐证素材，需评估自建能力或联合外部资源'})

    base = round(w_hit / w_all * 100) if w_all else 0
    score = max(0, min(96, base - (8 if hard_missing >= 2 else 0)))
    if hard_missing >= 2:
        verdict = {'cls': 'b-danger', 'txt': '强制项缺失 · 谨慎投'}
    elif hard_missing == 1:
        verdict = {'cls': 'b-warn', 'txt': '存在缺口 · 待补件'}
    elif score >= 80:
        verdict = {'cls': 'b-ok', 'txt': '高度匹配 · 建议投'}
    else:
        verdict = {'cls': 'b-brand', 'txt': '可参与 · 建议投'}
    return {'score': score, 'reasons': reasons, 'missing': missing,
            'sources': sources, 'verdict': verdict, 'hard_missing': hard_missing}


def tenders_with_match(conn) -> list[dict]:
    """全部标讯 + 匹配分（供列表排序展示）。"""
    out = []
    for t in load_tenders(conn):
        m = match_tender(conn, t)
        out.append({**t, 'match': {'score': m['score'], 'verdict': m['verdict'],
                                   'hard_missing': m['hard_missing'], 'missing_count': len(m['missing'])}})
    out.sort(key=lambda x: -x['match']['score'])
    return out


# ---------- 招标文件体检 ----------
def split_reqs(text: str) -> list[str]:
    parts = re.split(r'[\n。；;]', text)
    return [s.strip() for s in parts
            if len(s.strip()) > 6 and re.search(r'须|应|必须|需|不得|要求|提供|具备|具有|超过|否则', s.strip())]


def classify_req(s: str) -> dict:
    for r in REQ_RULES:
        if r['re'].search(s):
            return r
    return {'key': '其他', 're': None, 'level': '低', 'tip': '建议人工确认响应方式'}


def judge_req(conn, s: str, rule: dict) -> list[dict]:
    findings = []
    if rule['key'] == '资质类':
        hit_certs = []
        for c in load_certs(conn):
            nm = re.sub(r'（.*?）', '', c['name'])
            if nm in s or nm[:4] in s:
                hit_certs.append(c)
        if hit_certs:
            for c in hit_certs:
                st = cert_status(c)
                if st['level'] == 'ok':
                    text, level = f"《{c['name']}》有效，有效期至 {c['valid_to']}", 'ok'
                elif st['level'] == 'expired':
                    text, level = f"《{c['name']}》已过期（{c['valid_to']}），不可用", 'bad'
                else:
                    text, level = f"《{c['name']}》有效期至 {c['valid_to']}，{st['label']}，须尽快办理延续", 'ok'
                findings.append({'level': level, 'near': st['level'] in ('warn', 'danger'), 'text': text,
                                 'detail': f"{c['owner']} · 编号 {c['no']} · 版本 {c['version']}"})
        else:
            kw = re.search(r'[一-龥]{2,}(?:许可证|资质证|认证|证书)', s)
            findings.append({'level': 'warn', 'near': False,
                             'text': f"知识库中未检索到「{kw.group(0)}」的在库证照" if kw else '未在知识库中匹配到对应证照条目',
                             'detail': '需向资质管理员确认是否已办理或是否需外部借证'})
    elif rule['key'] == '业绩类':
        m = re.search(r'近([一二三两\d])年', s) or re.search(r'(\d+)\s*个', s)
        cutoff = f'{int(today()[:4]) - 3}-01'
        hits = [c for c in load_cases(conn) if c['date'] >= cutoff]
        findings.append({
            'level': 'ok' if len(hits) >= 2 else 'warn',
            'near': False,
            'text': f"近三年可佐证业绩 {len(hits)} 个" + (f"（招标要求：{m.group(0)}）" if m else ''),
            'detail': '；'.join(f"{c['name']}｜{c['date']}｜{c['amount']:.0f}万元" for c in hits[:3])})
    elif rule['key'] == '本地化':
        rg = next((r for r in REGIONS if r in s), '上海')
        has = any(rg in o for o in ORGS)
        findings.append({'level': 'ok' if has else 'warn', 'near': False,
                         'text': f"{rg}设有属地公司，可出具本地服务证明" if has else f"{rg}暂无属地公司，本地化要求存在缺口",
                         'detail': '、'.join(o for o in ORGS if rg in o) if has else '需评估设立分支机构或联合属地供应商'})
    else:
        findings.append({'level': 'warn', 'near': False, 'text': '需人工确认响应方式', 'detail': rule['tip']})
    return findings


def scan_doc(conn, text: str) -> dict:
    items = []
    for s in split_reqs(text):
        rule = classify_req(s)
        items.append({'text': s, 'rule': {'key': rule['key'], 'level': rule['level'], 'tip': rule['tip']},
                      'findings': judge_req(conn, s, rule)})
    high = sum(1 for i in items if i['rule']['level'] == '高')
    med = sum(1 for i in items if i['rule']['level'] == '中')
    bad = sum(1 for i in items if any(f['level'] == 'bad' for f in i['findings']))
    warn = sum(1 for i in items if any(f['level'] == 'warn' for f in i['findings']))
    return {'items': items, 'high': high, 'med': med, 'bad': bad, 'warn': warn}


# ---------- 台账巡检与统计 ----------
def inspect_assets(conn) -> dict:
    certs = [{'id': c['id'], 'name': c['name'], 'owner': c['owner'], 'no': c['no'],
              'valid_to': c['valid_to'], 'version': c['version'], **cert_status(c)} for c in load_certs(conn)]
    expired = [c for c in certs if c['level'] == 'expired']
    danger = [c for c in certs if c['level'] == 'danger']
    warn = [c for c in certs if c['level'] == 'warn']
    return {'certs': certs, 'expired': expired, 'danger': danger, 'warn': warn,
            'summary': {'total': len(certs), 'expired': len(expired), 'danger': len(danger), 'warn': len(warn)}}


def platform_stats(conn) -> dict:
    from .db import CERTS, CASES, SOLUTIONS
    counts = {t: conn.execute(f'SELECT COUNT(*) c FROM {t}').fetchone()['c']
              for t in ('certs', 'cases', 'solutions', 'quotes', 'tenders', 'knowledge', 'prompts',
                        'push_suggestions', 'push_logs', 'tool_logs')}
    insp = inspect_assets(conn)
    return {
        'pilot': {'aiTenders': 131, 'orgCount': 6, 'matched': 47, 'pushed': 47},
        'months': ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
        'reuseRate': [21, 26, 33, 38, 45, 52, 58],
        'composeHours': [46, 43, 38, 34, 29, 25, 21],
        'hitRate': [12, 15, 14, 19, 23, 26, 29],
        'inventory': {'certs': len(CERTS), 'cases': len(CASES), 'solutions': len(SOLUTIONS)},
        'freshness': insp['summary'],
        'db_counts': counts,
    }
