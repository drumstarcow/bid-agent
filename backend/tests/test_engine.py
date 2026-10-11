# -*- coding: utf-8 -*-
"""业务引擎测试：匹配梯度、体检判定、RAG 检索、建议书、巡检。"""
from app import engine, proposal
from app.engine import SAMPLE_DOC


def test_seed_counts(conn):
    assert len(engine.load_tenders(conn)) == 12
    assert len(engine.load_certs(conn)) == 12
    assert len(engine.load_cases(conn)) == 12
    assert len(engine.load_knowledge(conn)) == 15


def test_match_gradient(conn):
    """匹配分必须拉开真实梯度：最高 90+，医用耗材（双强制缺口）低分谨慎投。"""
    tenders = engine.load_tenders(conn)
    scored = {t['id']: engine.match_tender(conn, t) for t in tenders}
    top = max(s['score'] for s in scored.values())
    assert top >= 90
    medical = scored['B-2612']
    assert medical['score'] <= 40
    assert medical['verdict']['txt'] == '强制项缺失 · 谨慎投'
    assert medical['hard_missing'] >= 2
    # 湖北无属地公司 → 存在缺口
    wuhan = scored['B-2611']
    assert wuhan['verdict']['txt'] == '存在缺口 · 待补件'
    assert wuhan['hard_missing'] == 1


def test_cert_status_expired(conn):
    certs = {c['id']: c for c in engine.load_certs(conn)}
    st = engine.cert_status(certs['C-012'])  # 2025-10-10 到期
    assert st['level'] == 'expired'
    st2 = engine.cert_status(certs['C-001'])  # 2028 年
    assert st2['level'] == 'ok'


def test_scan_doc(conn):
    s = engine.scan_doc(conn, SAMPLE_DOC)
    assert s['high'] + s['med'] >= 10
    assert len(s['items']) >= 10
    # 示例文件要求 ISO9001 → 库内有效
    iso = [i for i in s['items'] if 'ISO9001' in i['text']]
    assert iso and any(f['level'] == 'ok' for f in iso[0]['findings'])


def test_rag_search(conn):
    hits = engine.rag_search(conn, '技术偏离表怎么填')
    assert hits and hits[0]['doc']['title'].startswith('技术偏离表')
    empty = engine.rag_search(conn, 'xyz')
    assert isinstance(empty, list)


def test_proposal(conn):
    t = engine.get_tender(conn, 'B-2601')
    html = proposal.build_proposal_html(conn, t)
    for section in ('一、项目概况', '三、我方资质符合性', '六、报价策略', '九、决策建议'):
        assert section in html
    assert '匹配度' in html


def test_inspect_assets(conn):
    inv = engine.inspect_assets(conn)
    assert inv['summary']['total'] == 12
    assert inv['summary']['expired'] >= 2
