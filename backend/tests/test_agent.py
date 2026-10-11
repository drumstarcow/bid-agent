# -*- coding: utf-8 -*-
"""智能体与 API 测试：规则模式意图、工具审计、角色白名单、推送人工确认闭环。"""
from app import db
from app.agent import chat
from app.agent_tools import execute_tool


def test_rules_intents_call_tools(client):
    for msg, expect_tool in [
        ('最近有哪些标讯能投', 'search_tenders'),
        ('为 B-2612 生成投标建议书', 'generate_proposal_preview'),
        ('帮我体检一份招标文件', 'scan_tender_text'),
        ('有哪些证快到期了', 'get_cert_inventory'),
        ('技术偏离表怎么填', 'search_knowledge'),
        ('中台的命中率指标怎么样', 'get_platform_stats'),
    ]:
        r = chat(msg, 'hr')
        assert r['mode'] == 'rules'
        assert r['answer'].strip()
        assert any(l['tool'] == expect_tool and l['success'] for l in r['logs']), (msg, r['logs'])


def test_push_requires_human_confirm(client):
    """智能体只能生成待确认建议；HR 确认后才写推送记录。"""
    r = chat('把第一条标讯推送一下', 'hr')
    assert any(l['tool'] == 'create_push_suggestion' and l['success'] for l in r['logs'])
    assert '尚未发送' in r['answer'] or '人工确认' in r['answer']
    with db.connect() as conn:
        n_logs = conn.execute('SELECT COUNT(*) c FROM push_logs').fetchone()['c']
    assert n_logs == 0  # 未确认前不得有推送记录
    pend = client.get('/api/push/suggestions').json()
    assert pend and pend[0]['status'] == 'pending'
    sid = pend[0]['id']
    # member 角色确认 → 403
    resp = client.post(f'/api/push/suggestions/{sid}/confirm', json={'role': 'member', 'confirmed': True})
    assert resp.status_code == 403
    # HR 未带 confirmed → 403
    resp = client.post(f'/api/push/suggestions/{sid}/confirm', json={'role': 'hr', 'confirmed': False})
    assert resp.status_code == 403
    # HR 人工确认 → 写入推送记录
    resp = client.post(f'/api/push/suggestions/{sid}/confirm', json={'role': 'hr', 'confirmed': True})
    assert resp.status_code == 200 and resp.json()['status'] == 'sent'
    with db.connect() as conn:
        n_logs = conn.execute('SELECT COUNT(*) c FROM push_logs').fetchone()['c']
        assert n_logs == 1
    # 重复确认 → 409
    resp = client.post(f'/api/push/suggestions/{sid}/confirm', json={'role': 'hr', 'confirmed': True})
    assert resp.status_code == 409


def test_member_role_cannot_push(client):
    """member 角色工具白名单中无推送工具。"""
    r = execute_tool('create_push_suggestion', {'tender_id': 'B-2601', 'channels': ['飞书'], 'reason': 'x'},
                     run_id='t-member', role='member')
    assert not r['ok']


def test_tool_validation(conn):
    r = execute_tool('get_cert_inventory', {'status': 'bogus'}, run_id='t1', role='hr')
    assert not r['ok']
    r2 = execute_tool('get_tender_detail', {'tender_id': 'B-9999'}, run_id='t2', role='hr')
    assert not r2['ok']
    r3 = execute_tool('get_tender_detail', {'tender_id': 'B-2601'}, run_id='t3', role='hr')
    assert r3['ok'] and r3['data']['match_score'] > 0


def test_agent_logs_endpoint(client):
    chat('最近有哪些标讯能投', 'hr')
    logs = client.get('/api/agent/logs?limit=10').json()
    assert logs and 'tool' in logs[0] and 'duration_ms' in logs[0]


def test_health_and_bootstrap(client):
    h = client.get('/api/health').json()
    assert h['status'] == 'ok' and h['database'] == 'sqlite'
    b = client.get('/api/bootstrap').json()
    assert len(b['tenders']) == 12 and len(b['certs']) == 12
    assert all('match' in t for t in b['tenders'])
    assert b['tenders'][0]['match']['score'] >= b['tenders'][-1]['match']['score']


def test_proposal_endpoint(client):
    r = client.get('/api/tenders/B-2601/proposal')
    assert r.status_code == 200
    assert '九、决策建议' in r.json()['html']
    assert client.get('/api/tenders/B-9999/proposal').status_code == 404
