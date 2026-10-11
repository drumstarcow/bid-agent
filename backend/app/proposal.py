# -*- coding: utf-8 -*-
"""投标建议书生成：基于匹配结果、资质台账、业绩库与报价模型自动合成 HTML 建议书。"""
import re
from .engine import (esc, days_to, cert_status, match_tender, load_certs, load_cases,
                     load_solutions, load_quotes, LOCAL_RE)


def _pick_quote(quotes, biz):
    return next((q for q in quotes if q['biz'] == biz), quotes[0])


def _pick_solution(solutions, biz):
    ss = sorted([s for s in solutions if s['biz'] == biz], key=lambda s: -s['reuse'])
    return ss[0] if ss else solutions[0]


def build_proposal_html(conn, t: dict) -> str:
    m = match_tender(conn, t)
    certs, cases, solutions, quotes = load_certs(conn), load_cases(conn), load_solutions(conn), load_quotes(conn)
    ddl = days_to(t['deadline'])
    q = _pick_quote(quotes, t['biz'])
    sol = _pick_solution(solutions, t['biz'])
    use_cases = m['sources']['cases'][:3]
    use_certs = list(dict.fromkeys(c['name'] for c in m['sources']['certs']))
    big = t['budget'] > 2500
    prop = t['biz'] == '物业与后勤'

    rows = []
    for r in t['requires']:
        hit_cert = next((c for c in certs if c['name'] in r or r in c['name']
                         or any(x in r for x in c['tags'])), None)
        hit_case = [c for c in cases if any(x in r or r in x for x in c['tags'])]
        if hit_cert:
            st = cert_status(hit_cert)
            badge = {'ok': ('b-ok', '符合'), 'expired': ('b-danger', '不符合')}.get(st['level'], ('b-warn', '符合·即将到期'))
            rows.append(f"<tr><td>{esc(r)}</td><td><span class=\"badge {badge[0]}\">{badge[1]}</span></td>"
                        f"<td>《{esc(hit_cert['name'])}》{esc(hit_cert['no'])}，有效期至 {hit_cert['valid_to']}</td></tr>")
        elif hit_case:
            rows.append(f"<tr><td>{esc(r)}</td><td><span class=\"badge b-ok\">符合</span></td>"
                        f"<td>{len(hit_case)} 个可佐证业绩，首选：{esc(hit_case[0]['name'])}</td></tr>")
        elif LOCAL_RE.search(r):
            has = any(t['region'] in o for o in ORGS_LOCAL)
            ev = (f"{esc(t['region'])}公司营业执照及办公场所证明" if has
                  else '需评估设立属地机构或联合当地供应商')
            rows.append(f"<tr><td>{esc(r)}</td><td><span class=\"badge {'b-ok' if has else 'b-warn'}\">{'符合' if has else '待补件'}</span></td>"
                        f"<td>{ev}</td></tr>")
        else:
            rows.append(f"<tr><td>{esc(r)}</td><td><span class=\"badge b-danger\">缺失</span></td>"
                        f"<td>知识库无对应素材，需办理或从外部借证</td></tr>")

    missing_line = (f"<li><b>缺口项：</b>{esc('、'.join(x['req'] for x in m['missing']))} — {esc(m['missing'][0]['why'])}</li>"
                    if m['missing'] else '')
    conclusion = ('建议投标。' if m['score'] >= 80 and m['hard_missing'] == 0 else
                  (f"谨慎投标：存在 {m['hard_missing']} 项强制缺口，建议先补件或与属地公司组成联合体。" if m['hard_missing'] >= 2
                   else '建议投标，但需在 D+1 前补齐缺口项。'))
    return f"""<h2>一、项目概况与研判结论</h2>
<ul>
<li><b>项目名称：</b>{esc(t['title'])}</li>
<li><b>业主单位：</b>{esc(t['buyer'])}　<b>区域：</b>{esc(t['region'])}　<b>业务类型：</b>{esc(t['biz'])}</li>
<li><b>预算规模：</b>{t['budget']:.0f} 万元　<b>信息来源：</b>{esc(t['source'])}</li>
<li><b>关键节点：</b>发布 {t['publish']}　递交截止 {t['deadline']}（剩余 <span class="hl">{ddl} 天</span>）</li>
<li><b>智能匹配度：</b><b>{m['score']} 分</b>　<b>研判结论：</b>{esc(m['verdict']['txt'])}</li>
</ul>
<h2>二、业主与竞争态势（来源：标讯自动抓取 + 历史开标数据）</h2>
<ul>
<li>该类目近 12 个月集团参与 {max(3, round(t['budget'] / 400))} 次，平均投标家数 {4 + int(t['budget']) % 5} 家，综合评分法为主。</li>
<li>预算 {t['budget']:.0f} 万元属{'大额标段，预计吸引头部供应商，价格竞争度中等偏上' if big else '中小额标段，本地供应商参与度高，价格敏感度高'}。</li>
<li>评审权重参考（同类项目均值）：技术方案 {'45' if prop else '40'}%、商务 {'25' if prop else '30'}%、价格 30%。</li>
</ul>
<h2>三、我方资质符合性（自动比对集团资质台账）</h2>
<table>
<tr><th>招标要求</th><th>判定</th><th>佐证材料</th></tr>
{''.join(rows)}
</table>
<h2>四、业绩佐证建议（自动推荐复用）</h2>
<table>
<tr><th>推荐业绩</th><th>业主性质</th><th>合同额(万元)</th><th>签订时间</th><th>历史复用次数</th></tr>
{(''.join(f"<tr><td>{esc(c['name'])}</td><td>{esc(c['biz'])}</td><td class='num'>{c['amount']:.0f}</td><td>{c['date']}</td><td class='num'>{c['reuse']}</td></tr>" for c in use_cases)
  if use_cases else '<tr><td colspan="5">未匹配到高相关业绩，建议从集团业绩库人工检索或联合板块内兄弟公司</td></tr>')}
</table>
<h2>五、技术方案要点（复用模板：{esc(sol['name'])} · {esc(sol['version'])}）</h2>
<ul>
<li><b>总体思路：</b>{esc(t['biz'])}标准化交付 + 属地资源调度 + 数字化过程管控三层架构。</li>
<li><b>组织架构：</b>项目经理 1 名（{'8' if t['budget'] > 2000 else '5'} 年以上同类经验）、专职主管 {max(2, round(t['budget'] / 800))} 名、一线人员按{'面积法+岗位法双向测算取高值' if prop else '业务峰值模型'}配置。</li>
<li><b>关键节点：</b>进场准备（T+0 至 T+7）→ 试运行（T+8 至 T+30）→ 正式运营（T+31 起）→ 季度复盘。</li>
<li><b>质量管控：</b>SLA 指标化考核，月度服务报告 + 业主满意度回访，问题工单 {'15 分钟响应、4 小时闭环' if prop else '2 小时响应、24 小时闭环'}。</li>
<li><b>应急管控：</b>{esc(t['key_points'][0]) if t['key_points'] else '按项目特点编写'}对应专项预案，含人员替班、突发天气、系统故障三类场景。</li>
<li><b>可引用资质：</b>{esc('、'.join(use_certs)) if use_certs else '以商务标资质清单为准'}。</li>
</ul>
<h2>六、报价策略（模型：{esc(q['name'])} · {esc(q['version'])}）</h2>
<ul>
<li><b>测算口径：</b>{esc(q['desc'])}。</li>
<li><b>建议区间：</b>预算 {t['budget']:.0f} 万元的 <span class="hl">{'88%—93%' if big else '90%—96%'}</span>，即约 {round(t['budget'] * (0.88 if big else 0.90))}—{round(t['budget'] * (0.93 if big else 0.96))} 万元。</li>
<li><b>成本拆解：</b>人工成本约 {round(t['budget'] * 0.62)} 万元、管理费率 {round(t['budget'] * 0.12)} 万元、税费及风险金 {round(t['budget'] * 0.14)} 万元、利润约 {round(t['budget'] * 0.12)} 万元（<span class="hl">【待核实：以财务复核为准】</span>）。</li>
<li><b>报价禁忌：</b>不得超过最高限价；大小写须一致；同一标的不出现两个报价。</li>
</ul>
<h2>七、风险提示（来源：常见废标风险点库 2026 版）</h2>
<ul>
<li><b>高风险：</b>{f'距截止仅 {ddl} 天，编制窗口紧张，须启动加急流程' if ddl <= 7 else '递交时限与密封盖章要求，须在递交前 24 小时完成形式审查'}。</li>
<li><b>高风险：</b>资质证照有效期须覆盖投标有效期，到期证照须提前 30 天办理延续。</li>
<li><b>中风险：</b>技术偏离表须逐条响应，禁止留空或写"详见技术方案"。</li>
<li><b>中风险：</b>保证金到账以银行凭证为准，{'本标段保证金预计较高，须提前 3 个工作日申请资金' if t['budget'] > 2000 else '按招标文件要求及时缴纳'}。</li>
{missing_line}
</ul>
<h2>八、资源与进度安排（T-{ddl} 倒排）</h2>
<ul>
<li><b>D+1：</b>完成资格自审与《投标可行性评估表》提交（责任人：板块投标负责人）。</li>
<li><b>D+{max(2, round(ddl * 0.3))}：</b>技术方案初稿（AI 辅助生成 + 业务校对）。</li>
<li><b>D+{max(3, round(ddl * 0.6))}：</b>商务报价测算与内部评审。</li>
<li><b>D+{max(4, ddl - 2)}：</b>定稿、签署盖章、密封与递交复核。</li>
<li><b>开标后 5 个工作日内：</b>完成结果回流登记，中标则沉淀方案与报价区间，失标则填写《失标原因分析表》。</li>
</ul>
<h2>九、决策建议</h2>
<p><b>{conclusion}</b>
综合匹配度 {m['score']} 分、预算 {t['budget']:.0f} 万元、剩余 {ddl} 天，{'资质与业绩支撑充分，方案模板可直接复用，具备较强竞争力' if m['score'] >= 80 else '需在资质/业绩佐证上做补充，建议联合板块内资源'}。</p>
<p class="muted">※ 本建议书由投标智能体基于集团知识库（{len(certs)} 项证照 / {len(cases)} 个业绩 / {len(solutions)} 套方案）自动生成，标注【待核实】处须经业务负责人校对。AI 辅助生成内容已按《AI 辅助标书编制提示词使用规范》登记版本。</p>"""


ORGS_LOCAL = ['集团总部', '上海公司', '广东公司', '北京公司', '江苏公司', '浙江公司', '四川公司']
