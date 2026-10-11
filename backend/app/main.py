# -*- coding: utf-8 -*-
"""REST API：工作台数据、智能体对话、审计日志、推送建议人工确认闭环，并静态托管前端。"""
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from . import db
from .db import connect, initialize, seed, now, event, today
from .engine import tenders_with_match, load_certs, load_cases, load_solutions, load_quotes, \
    load_knowledge, cert_status, platform_stats, ORGS, REGIONS, BIZ_TYPES
from .proposal import build_proposal_html
from .agent_tools import execute_tool
from .agent import chat, configured

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'frontend')


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=6000)
    role: Literal['hr', 'member'] = 'hr'

    @field_validator('message')
    @classmethod
    def nonempty(cls, v):
        if not v.strip():
            raise ValueError('消息不能为空')
        return v.strip()


class ConfirmRequest(BaseModel):
    role: Literal['hr', 'member']
    confirmed: bool = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    with connect() as conn:
        seed(conn)
    yield


app = FastAPI(title='投标智能体中台', version='1.0.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:8000', 'http://127.0.0.1:8000'],
                   allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])


@app.get('/api/health')
def health():
    with connect() as conn:
        conn.execute('SELECT 1')
    return {'status': 'ok', 'database': 'sqlite', 'mode': 'llm' if configured() else 'rules',
            'demo': True, 'today': today()}


@app.get('/api/bootstrap')
def bootstrap():
    """前端一次性加载全部基础数据（证照含实时有效期状态、标讯含实时匹配分）。"""
    with connect() as conn:
        certs = [{**c, 'status': cert_status(c)} for c in load_certs(conn)]
        tenders = tenders_with_match(conn)
        st = platform_stats(conn)
        pushes = conn.execute('''SELECT s.*, t.title tender_title FROM push_suggestions s
                                 LEFT JOIN tenders t ON t.id = s.tender_id ORDER BY s.id DESC''').fetchall()
        return {'today': today(), 'orgs': ORGS, 'regions': REGIONS, 'biz_types': BIZ_TYPES,
                'certs': certs, 'cases': load_cases(conn), 'solutions': load_solutions(conn),
                'quotes': load_quotes(conn), 'tenders': tenders, 'knowledge': load_knowledge(conn),
                'prompts': [dict(r) for r in conn.execute('SELECT * FROM prompts ORDER BY key')],
                'stats': st, 'mode': 'llm' if configured() else 'rules',
                'push_suggestions': [dict(p) | {'channels': json.loads(p['channels'])} for p in pushes]}


@app.get('/api/workspace')
def workspace():
    with connect() as conn:
        st = platform_stats(conn)
        events = [dict(e) for e in conn.execute('SELECT * FROM events ORDER BY id DESC LIMIT 20')]
        pending = conn.execute('''SELECT s.*, t.title tender_title FROM push_suggestions s
                                  LEFT JOIN tenders t ON t.id=s.tender_id
                                  WHERE s.status='pending' ORDER BY s.id DESC''').fetchall()
        return {'mode': 'llm' if configured() else 'rules', 'today': today(),
                'stats': st, 'events': events,
                'pending_suggestions': [dict(p) | {'channels': json.loads(p['channels'])} for p in pending]}


@app.get('/api/tenders/{tender_id}/proposal')
def tender_proposal(tender_id: str):
    with connect() as conn:
        t = next((x for x in tenders_with_match(conn) if x['id'] == tender_id.upper()), None)
        if not t:
            raise HTTPException(404, '标讯不存在')
        html = build_proposal_html(conn, t)
    event_conn = connect()
    with event_conn:
        event(event_conn, 'hr', '生成投标建议书', f"{t['id']} {t['title'][:30]}")
    return {'tender_id': t['id'], 'title': t['title'], 'html': html}


@app.post('/api/agent/chat')
def agent_chat(body: ChatRequest):
    return chat(body.message, body.role)


@app.get('/api/agent/logs')
def agent_logs(limit: int = 100):
    with connect() as conn:
        rows = conn.execute('SELECT * FROM tool_logs ORDER BY id DESC LIMIT ?',
                            (max(1, min(limit, 500)),)).fetchall()
        return [dict(r) | {'arguments': json.loads(r['arguments']), 'result': json.loads(r['result'])}
                for r in rows]


@app.get('/api/events')
def events():
    with connect() as conn:
        return [dict(e) for e in conn.execute('SELECT * FROM events ORDER BY id DESC LIMIT 100')]


@app.get('/api/push/suggestions')
def push_suggestions():
    with connect() as conn:
        rows = conn.execute('''SELECT s.*, t.title tender_title, t.region, t.biz, t.budget
                               FROM push_suggestions s LEFT JOIN tenders t ON t.id=s.tender_id
                               ORDER BY s.id DESC''').fetchall()
        return [dict(r) | {'channels': json.loads(r['channels'])} for r in rows]


@app.post('/api/push/suggestions/{sid}/confirm')
def confirm_push(sid: int, body: ConfirmRequest):
    """人工确认推送：只有 HR 角色 + confirmed=true 才执行；写入推送记录与审计事件。"""
    if body.role != 'hr' or not body.confirmed:
        raise HTTPException(403, '推送发送需要 HR 角色人工确认')
    with connect() as conn:
        p = conn.execute('SELECT * FROM push_suggestions WHERE id=?', (sid,)).fetchone()
        if not p:
            raise HTTPException(404, '推送建议不存在')
        if p['status'] != 'pending':
            raise HTTPException(409, '该建议已处理，请勿重复确认')
        conn.execute("UPDATE push_suggestions SET status='confirmed' WHERE id=?", (sid,))
        conn.execute('INSERT INTO push_logs(tender_id,channels,operator,source,created_at) VALUES(?,?,?,?,?)',
                     (p['tender_id'], p['channels'], 'hr', 'agent+human_confirm', now()))
        t = conn.execute('SELECT title FROM tenders WHERE id=?', (p['tender_id'],)).fetchone()
        event(conn, 'hr', '确认推送（人工确认后执行）',
              f"{p['tender_id']} {t['title'][:24] if t else ''} → {p['channels']}（渠道模拟发送）")
        return {'status': 'sent', 'channels': json.loads(p['channels']),
                'message': 'HR 已确认，推送记录已写入数据库（渠道为演示模拟）。'}


@app.post('/api/push/suggestions/{sid}/discard')
def discard_push(sid: int, body: ConfirmRequest):
    if body.role != 'hr':
        raise HTTPException(403, '仅 HR 可处理推送建议')
    with connect() as conn:
        p = conn.execute('SELECT * FROM push_suggestions WHERE id=?', (sid,)).fetchone()
        if not p:
            raise HTTPException(404, '推送建议不存在')
        if p['status'] != 'pending':
            raise HTTPException(409, '该建议已处理')
        conn.execute("UPDATE push_suggestions SET status='discarded' WHERE id=?", (sid,))
        event(conn, 'hr', '忽略推送建议', f"建议 #{sid}（{p['tender_id']}）")
        return {'status': 'discarded'}


@app.post('/api/agent/tools/{name}')
def call_tool(name: str, body: dict):
    """供前端页面直接调用业务工具（同样走校验与审计）。body 需含 role 与 params。"""
    role = body.get('role', 'hr')
    if role not in ('hr', 'member'):
        raise HTTPException(422, 'role 不合法')
    run_id = uuid.uuid4().hex[:12]
    result = execute_tool(name, body.get('params') or {}, run_id=run_id, role=role, mode='ui')
    return result | {'run_id': run_id}


# 静态托管前端（放在 API 路由之后）
if os.path.isdir(FRONTEND_DIR):
    app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
