# -*- coding: utf-8 -*-
"""智能体业务工具层：8 个真实查库工具，供规则模式与 LLM 模式共用。
所有调用经 execute_tool 统一做参数校验、角色白名单检查并写入 SQLite 审计日志。
工具白名单不包含审批、任意 SQL、状态修改与实际推送——推送仅生成待人工确认的建议。"""
import json
import time
from fastapi import HTTPException
from .db import connect, now, event, today
from .engine import (match_tender, tenders_with_match, scan_doc, rag_search, synthesize_text,
                     inspect_assets, platform_stats, load_quotes, get_tender, days_to, load_cases)


# ---------- 工具实现（第一参数均为 conn） ----------
def search_tenders(conn, region: str | None = None, biz: str | None = None,
                   keyword: str | None = None, limit: int = 8) -> list[dict]:
    """按区域/业务线/关键词筛选标讯，附真实匹配评分与研判结论。"""
    items = tenders_with_match(conn)
    if region:
        items = [t for t in items if region in t['region']]
    if biz:
        items = [t for t in items if biz in t['biz'] or t['biz'] in biz]
    if keyword:
        items = [t for t in items if keyword in t['title'] or keyword in t['buyer']
                 or any(keyword in r for r in t['requires'])]
    return [{'id': t['id'], 'title': t['title'], 'buyer': t['buyer'], 'region': t['region'],
             'biz': t['biz'], 'budget': t['budget'], 'deadline': t['deadline'],
             'days_left': days_to(t['deadline']), 'match_score': t['match']['score'],
             'verdict': t['match']['verdict']['txt']}
            for t in items[:max(1, min(limit, 12))]]


def get_tender_detail(conn, tender_id: str) -> dict:
    """单条标讯详情：匹配命中理由、缺口清单与可用佐证来源。"""
    t = get_tender(conn, tender_id)
    if not t:
        raise HTTPException(404, f'标讯 {tender_id} 不存在')
    m = match_tender(conn, t)
    return {'id': t['id'], 'title': t['title'], 'buyer': t['buyer'], 'region': t['region'],
            'biz': t['biz'], 'budget': t['budget'], 'deadline': t['deadline'],
            'days_left': days_to(t['deadline']), 'requires': t['requires'], 'key_points': t['key_points'],
            'match_score': m['score'], 'verdict': m['verdict']['txt'],
            'hit_reasons': m['reasons'], 'gaps': m['missing'],
            'available_certs': [c['name'] for c in m['sources']['certs']],
            'available_cases': [c['name'] for c in m['sources']['cases'][:5]],
            'available_solutions': [s['name'] for s in m['sources']['solutions'][:3]]}


def scan_tender_text(conn, text: str, doc_name: str = '粘贴的招标文件') -> dict:
    """招标文件废标风险体检：强制条款解析 + 资质符合性判定。"""
    if len(text) > 6000:
        text = text[:6000]
    s = scan_doc(conn, text)
    # 完整逐条结果（剥离不可序列化的正则对象），供前端「招标体检」页渲染
    items = [{'text': i['text'],
              'rule': {'key': i['rule']['key'], 'level': i['rule']['level'], 'tip': i['rule']['tip']},
              'findings': i['findings']} for i in s['items']]
    return {'doc_name': doc_name[:60], 'total_clauses': len(s['items']),
            'high_level_clauses': s['high'], 'mid_level_clauses': s['med'],
            'unqualified': s['bad'], 'need_confirm': s['warn'],
            'risk_verdict': ('存在废标级风险，须优先整改' if s['bad'] else
                             ('整体可控，存在待确认项' if s['warn'] else '未发现明显风险')),
            'items': items,
            'key_findings': [{'clause': i['text'][:60], 'category': i['rule']['key'], 'level': i['rule']['level'],
                              'finding': i['findings'][0]['text'] if i['findings'] else '需人工确认'}
                             for i in s['items'][:8]]}


def search_knowledge(conn, query: str) -> dict:
    """集团投标知识库 RAG 检索 + 生成式回答（附引用溯源）。"""
    return synthesize_text(conn, query)


def get_cert_inventory(conn, status: str = 'all') -> dict:
    """资质证照台账与新鲜度巡检。status: all/ok/warn/expired"""
    inv = inspect_assets(conn)
    mapping = {'ok': inv['certs'], 'warn': inv['warn'] + inv['danger'], 'expired': inv['expired']}
    rows = mapping.get(status, inv['certs'])
    return {'summary': inv['summary'], 'today': today(),
            'items': [{'id': c['id'], 'name': c['name'], 'owner': c['owner'], 'valid_to': c['valid_to'],
                       'status': c['label'], 'days_left': c['days']} for c in rows]}


def get_platform_stats(conn) -> dict:
    """中台运营指标：试点成效、素材复用率趋势、台账新鲜度。"""
    st = platform_stats(conn)
    return {'pilot': st['pilot'], 'inventory': st['inventory'], 'freshness': st['freshness'],
            'reuse_rate_trend': st['reuseRate'], 'compose_hours_trend': st['composeHours'],
            'hit_rate_trend': st['hitRate'], 'months': st['months'],
            'push_suggestions_pending': st['db_counts']['push_suggestions'],
            'push_logs_total': st['db_counts']['push_logs']}


def create_push_suggestion(conn, tender_id: str, channels: list[str], reason: str) -> dict:
    """生成标讯推送建议（仅保存待确认，不实际发送）。须 HR 在界面人工确认后才写入推送记录。"""
    t = get_tender(conn, tender_id)
    if not t:
        raise HTTPException(404, f'标讯 {tender_id} 不存在')
    valid_channels = [c for c in channels if c in ('飞书', '企业微信')]
    if not valid_channels:
        raise ValueError('推送渠道仅支持：飞书、企业微信')
    if len(reason) > 500:
        raise ValueError('推送说明过长（上限 500 字）')
    with connect() as c2:
        existing = c2.execute(
            "SELECT * FROM push_suggestions WHERE tender_id=? AND status='pending'", (t['id'],)).fetchone()
        if existing:
            return {'suggestion_id': existing['id'], 'status': 'pending', 'requires_confirmation': True,
                    'message': '该标讯已有待确认的推送建议，等待 HR 人工确认；尚未发送。'}
        cur = c2.execute('INSERT INTO push_suggestions(tender_id,channels,reason,created_at) VALUES(?,?,?,?)',
                         (t['id'], json.dumps(valid_channels, ensure_ascii=False), reason, now()))
        sid = cur.lastrowid
    event(conn, 'agent', '生成推送建议', f"{t['id']} {t['title'][:24]}… → {'/'.join(valid_channels)}；尚未发送")
    return {'suggestion_id': sid, 'tender_id': t['id'], 'tender_title': t['title'],
            'channels': valid_channels, 'status': 'pending', 'requires_confirmation': True,
            'message': '推送建议已保存，等待 HR 人工确认；尚未发送任何通知。'}


def generate_proposal_preview(conn, tender_id: str) -> dict:
    """生成投标建议书要点预览（完整建议书在前端「标书工坊」呈现，此处返回结构化摘要）。"""
    from .proposal import build_proposal_html
    t = get_tender(conn, tender_id)
    if not t:
        raise HTTPException(404, f'标讯 {tender_id} 不存在')
    m = match_tender(conn, t)
    ddl = days_to(t['deadline'])
    q = next((x for x in load_quotes(conn) if x['biz'] == t['biz']), load_quotes(conn)[0])
    big = t['budget'] > 2500
    return {'tender_id': t['id'], 'title': t['title'], 'match_score': m['score'],
            'verdict': m['verdict']['txt'], 'days_left': ddl,
            'quote_model': f"{q['name']} · {q['version']}",
            'quote_range': f"{round(t['budget'] * (0.88 if big else 0.90))}—{round(t['budget'] * (0.93 if big else 0.96))} 万元",
            'use_cases': [c['name'] for c in m['sources']['cases'][:3]],
            'use_certs': list(dict.fromkeys(c['name'] for c in m['sources']['certs'])),
            'gaps': [x['req'] for x in m['missing']],
            'milestones': [f'D+1 资格自审', f'D+{max(2, round(ddl * 0.3))} 技术方案初稿',
                           f'D+{max(3, round(ddl * 0.6))} 报价测算与评审', f'D+{max(4, ddl - 2)} 定稿递交'],
            'note': '完整建议书（九章节 HTML）已生成，请在「标书工坊」页面查看；【待核实】处须经业务负责人校对。'}


FUNCTIONS = {f.__name__: f for f in (search_tenders, get_tender_detail, scan_tender_text, search_knowledge,
                                     get_cert_inventory, get_platform_stats, create_push_suggestion,
                                     generate_proposal_preview)}

DESCRIPTIONS = {
    'search_tenders': '查询标讯池并按匹配度排序。可按 region（如 上海/广东）、biz（业务线）、keyword 过滤。',
    'get_tender_detail': '查询单条标讯详情：匹配命中理由、缺口清单、可用资质与业绩佐证。tender_id 形如 B-2601。',
    'scan_tender_text': '对招标文件原文做废标风险体检：解析强制条款并比对资质/业绩库，输出风险分级。',
    'search_knowledge': '检索集团投标知识库并生成带引用溯源的回答，适用于流程、规范、策略类问题。',
    'get_cert_inventory': '查询资质证照台账与到期巡检。status 可选 all/ok/warn/expired。',
    'get_platform_stats': '查询中台运营指标：试点成效、素材复用率、编制耗时、命中率趋势与推送统计。',
    'create_push_suggestion': '为标讯创建推送建议（仅飞书/企业微信）。只保存待确认建议，不发送通知；HR 确认后才执行推送。',
    'generate_proposal_preview': '为指定标讯生成投标建议书要点预览（匹配度、报价区间、佐证、倒排计划）。',
}


def tool_schemas(role: str) -> list[dict]:
    schemas = []
    for name, fn in FUNCTIONS.items():
        if name == 'create_push_suggestion' and role != 'hr':
            continue  # 推送建议仅 HR 角色可用
        props: dict = {}
        required: list[str] = []
        if name == 'search_tenders':
            props = {'region': {'type': 'string', 'description': '区域，如 上海'},
                     'biz': {'type': 'string', 'description': '业务线，如 物业与后勤'},
                     'keyword': {'type': 'string', 'description': '关键词'},
                     'limit': {'type': 'integer', 'description': '返回条数 1-12'}}
        elif name in ('get_tender_detail', 'generate_proposal_preview'):
            props = {'tender_id': {'type': 'string', 'description': '标讯编号，如 B-2601'}}
            required = ['tender_id']
        elif name == 'scan_tender_text':
            props = {'text': {'type': 'string', 'maxLength': 6000, 'description': '招标文件原文'},
                     'doc_name': {'type': 'string', 'maxLength': 60, 'description': '文档名称（可选）'}}
            required = ['text']
        elif name == 'search_knowledge':
            props = {'query': {'type': 'string', 'maxLength': 200, 'description': '问题或关键词'}}
            required = ['query']
        elif name == 'get_cert_inventory':
            props = {'status': {'type': 'string', 'enum': ['all', 'ok', 'warn', 'expired']}}
        elif name == 'create_push_suggestion':
            props = {'tender_id': {'type': 'string', 'description': '标讯编号'},
                     'channels': {'type': 'array', 'items': {'type': 'string', 'enum': ['飞书', '企业微信']},
                                  'description': '推送渠道列表'},
                     'reason': {'type': 'string', 'maxLength': 500, 'description': '推送说明'}}
            required = ['tender_id', 'channels', 'reason']
        schemas.append({'type': 'function', 'function': {'name': name, 'description': DESCRIPTIONS[name],
                        'parameters': {'type': 'object', 'properties': props, 'required': required,
                                       'additionalProperties': False}}})
    return schemas


def execute_tool(name: str, arguments: dict, *, run_id: str, role: str, mode: str = 'rules',
                 conn=None) -> dict:
    """统一工具执行入口：校验 schema → 执行 → 写审计日志。返回 {'ok': bool, 'data'/'error': ...}。"""
    start = time.perf_counter()
    success = False
    executed_arguments = dict(arguments)
    result: dict
    own_conn = conn is None
    try:
        schema = next((s['function']['parameters'] for s in tool_schemas(role)
                       if s['function']['name'] == name), None)
        if schema is None:
            raise ValueError('当前角色不允许调用该工具')
        args = dict(arguments)
        if set(args) - set(schema['properties']) or any(k not in args for k in schema['required']):
            raise ValueError('工具参数不合法')
        for key, value in args.items():
            spec = schema['properties'][key]
            if spec['type'] == 'integer' and (type(value) is not int or not (1 <= value <= 12)):
                raise ValueError('integer 参数不合法')
            if spec['type'] == 'string' and (not isinstance(value, str) or len(value) > spec.get('maxLength', 200)):
                raise ValueError('string 参数不合法')
            if spec['type'] == 'array' and (not isinstance(value, list) or not value):
                raise ValueError('array 参数不合法')
            if 'enum' in spec and value not in spec['enum']:
                raise ValueError('参数不在允许范围内')
        executed_arguments = args
        c = conn or connect()
        try:
            data = FUNCTIONS[name](c, **args)
            result = {'ok': True, 'data': data}
            success = True
        finally:
            if own_conn:
                c.close()
    except (ValueError, TypeError, KeyError, HTTPException) as exc:
        result = {'ok': False, 'error': exc.detail if isinstance(exc, HTTPException) else str(exc)}
    duration = round((time.perf_counter() - start) * 1000)
    with connect() as log_conn:
        log_conn.execute('''INSERT INTO tool_logs(run_id,mode,role,tool,arguments,result,success,duration_ms,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?)''',
                         (run_id, mode, role, name, json.dumps(executed_arguments, ensure_ascii=False),
                          json.dumps(result, ensure_ascii=False), int(success), duration, now()))
    return result
