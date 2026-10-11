/* ============================================================
 * 投标智能体中台 · 前端数据层
 * 业务数据以 SQLite（后端 /api/bootstrap）为唯一数据源；
 * 智能体工具调用统一走 /api，自动写入审计日志。
 * ============================================================ */

const API = {
  async get(path) {
    const r = await fetch('/api' + path);
    const j = await r.json();
    if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : '请求失败');
    return j;
  },
  async post(path, data) {
    const r = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : '请求失败');
    return j;
  }
};

/** 调用后端业务工具（带参数校验与审计日志） */
async function callTool(name, params, role = 'hr') {
  return API.post(`/agent/tools/${name}`, { role, params });
}

let BOOT = null;

/** 启动时从后端加载全部基础数据，映射为前端视图所需的驼峰字段 */
async function loadBootstrap() {
  BOOT = await API.get('/bootstrap');
  const b = BOOT;

  window.ORGS = b.orgs;
  window.REGIONS = b.regions;
  window.BIZ_TYPES = b.biz_types;
  window.TODAY = new Date(b.today + 'T00:00:00');
  window.MODE = b.mode;

  window.CERTS = b.certs.map(c => ({
    id: c.id, name: c.name, owner: c.owner, no: c.no,
    validFrom: c.valid_from, validTo: c.valid_to, version: c.version,
    file: c.file, tags: c.tags, status: c.status
  }));
  window.CASES = b.cases.map(c => ({
    id: c.id, name: c.name, client: c.client, region: c.region, biz: c.biz,
    amount: c.amount, date: c.date, tags: c.tags, reuse: c.reuse
  }));
  window.SOLUTIONS = b.solutions.map(s => ({
    id: s.id, name: s.name, biz: s.biz, version: s.version, updated: s.updated,
    owner: s.owner, reuse: s.reuse, author: s.author
  }));
  window.QUOTES = b.quotes.map(q => ({
    id: q.id, name: q.name, biz: q.biz, version: q.version, updated: q.updated,
    owner: q.owner, desc: q.desc
  }));
  window.TENDERS = b.tenders.map(t => ({
    id: t.id, title: t.title, buyer: t.buyer, region: t.region, biz: t.biz,
    budget: t.budget, publish: t.publish, deadline: t.deadline, source: t.source,
    requires: t.requires, keyPoints: t.key_points,
    match: { score: t.match.score, verdict: t.match.verdict, hardMissing: t.match.hard_missing }
  }));
  window.KNOWLEDGE = b.knowledge.map(k => ({
    id: k.id, title: k.title, source: k.source, updated: k.updated, text: k.text
  }));
  window.PROMPTS = {};
  (b.prompts || []).forEach(p => { window.PROMPTS[p.key] = { name: p.name, desc: p.desc, template: p.template }; });

  const st = b.stats;
  window.METRICS = {
    pilotCount: st.pilot.aiTenders, orgCount: st.pilot.orgCount,
    aiTenders: st.pilot.aiTenders, matched: st.pilot.matched, pushed: st.pilot.pushed,
    certCount: st.inventory.certs, caseCount: st.inventory.cases, solutionCount: st.inventory.solutions,
    months: st.months, reuseRate: st.reuse_rate_trend, composeHours: st.compose_hours_trend, hitRate: st.hit_rate_trend,
    freshness: st.freshness
  };
  window.PENDING_PUSH = b.push_suggestions.filter(p => p.status === 'pending');
  return b;
}
