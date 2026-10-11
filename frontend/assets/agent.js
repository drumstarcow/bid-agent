/* ============================================================
 * 投标对话智能体 · 前端客户端
 * 对话走后端 /api/agent/chat：规则模式（离线可跑）或 LLM 工具调用模式，
 * 每次工具调用在后端 SQLite 留痕，可在「执行与审计」页追溯。
 * 本文件同时负责：启动时加载 bootstrap 数据 + 审计视图 + 推送人工确认。
 * ============================================================ */

const agentState = { history: [], busy: false };

const MODE_BADGE = {
  rules: '<span class="badge b-gray">规则驱动演示模式</span>',
  llm: '<span class="badge b-ok">LLM 工具调用模式</span>',
  rules_fallback: '<span class="badge b-warn">LLM 不可用 · 已降级规则模式</span>'
};

const SAMPLE_MSGS = [
  '帮我看看最近有哪些标讯能投',
  '就医用耗材那个标，生成投标建议书',
  '做一次资质证照到期巡检',
  '技术偏离表怎么填才不废标？',
  '把匹配度最高的标推送到飞书'
];

function viewAgent() {
  return `
  <div class="agent-wrap">
    <div class="card agent-card">
      <div class="card-h">
        <div class="card-title-bar"><span class="dot" style="background:var(--purple)"></span>
          <h3>投标智能体</h3><span class="sub">规划 → 工具调用 → 观察 → 回答（全程可审计）</span></div>
        <div id="agentModeBadge">${MODE_BADGE[window.MODE || 'rules']}</div>
      </div>
      <div class="agent-msgs" id="agentMsgs"></div>
      <div class="agent-input-row">
        <input type="text" id="agentInput" placeholder="用自然语言下达指令，如：帮我看看最近有哪些标讯能投"
               onkeydown="if(event.key==='Enter'&&!event.isComposing)sendAgentMsg()">
        <button class="btn" id="agentSendBtn" onclick="sendAgentMsg()">发送</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        ${SAMPLE_MSGS.map(m => `<button class="btn btn-line btn-sm" onclick="sendAgentMsg('${m}')">${m}</button>`).join('')}
      </div>
    </div>
  </div>`;
}

function agentBubble(role, html, extra = '') {
  const wrap = document.getElementById('agentMsgs');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = `abubble ${role === 'user' ? 'a-user' : 'a-bot'}`;
  div.innerHTML = `<div class="a-role">${role === 'user' ? '你' : '投标智能体'}</div>
    <div class="a-body">${html}</div>${extra}`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function toolLogsHtml(logs) {
  if (!logs || !logs.length) return '';
  const rows = logs.map(l => {
    const ok = l.success;
    return `<div class="tlog">
      <div class="tlog-h"><span class="badge ${ok ? 'b-ok' : 'b-danger'}">${ok ? '成功' : '失败'}</span>
        <b>🔧 ${l.tool}</b><span class="muted">${l.duration_ms} ms · ${l.mode} 模式</span></div>
      <div class="tlog-d">参数：<code>${esc(JSON.stringify(l.arguments))}</code></div>
      <div class="tlog-d">返回：<code>${esc(JSON.stringify(l.result).slice(0, 260))}${JSON.stringify(l.result).length > 260 ? '…' : ''}</code></div>
    </div>`;
  }).join('');
  return `<details class="a-trace"><summary>👁 查看工具执行记录（${logs.length} 次，已写入审计日志）</summary>${rows}</details>`;
}

async function sendAgentMsg(preset) {
  const input = document.getElementById('agentInput');
  const msg = (preset || (input ? input.value : '')).trim();
  if (!msg || agentState.busy) return;
  if (input && !preset) input.value = '';
  agentBubble('user', esc(msg));
  agentState.busy = true;
  const btn = document.getElementById('agentSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = '思考中…'; }
  const thinking = agentBubble('bot', '<span class="a-thinking">🧠 规划任务 · 🔧 调用业务工具 · 👁 观察结果…</span>');
  try {
    const r = await API.post('/agent/chat', { message: msg, role: 'hr' });
    thinking.remove();
    const warn = r.warning ? `<div class="a-warn">⚠ ${esc(r.warning)}</div>` : '';
    const body = esc(r.answer).replace(/\n/g, '<br>');
    agentBubble('bot',
      `${warn}<div>${body}</div>
       <div style="margin-top:8px">${MODE_BADGE[r.mode] || ''}<span class="muted" style="margin-left:8px">run_id: ${r.run_id}</span></div>`,
      toolLogsHtml(r.logs));
    agentState.history.push({ q: msg, a: r.answer });
  } catch (e) {
    thinking.remove();
    agentBubble('bot', `<span style="color:var(--danger)">请求失败：${esc(e.message)}（请确认后端服务已启动）</span>`);
  } finally {
    agentState.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
  }
}

/* ===== 执行与审计 ===== */
function viewAudit() {
  return `
  <div class="grid g2" id="auditWrap">
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot"></span>
      <h3>工具执行日志</h3><span class="sub">最近 100 条 · 含参数与返回</span></div>
      <button class="btn-ghost" onclick="loadAudit()">刷新</button></div>
      <div id="auditLogs" class="muted">加载中…</div></div>
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--ok)"></span>
      <h3>业务事件流</h3><span class="sub">数据变更与人工确认记录</span></div></div>
      <div id="auditEvents" class="muted">加载中…</div></div>
  </div>`;
}

async function loadAudit() {
  try {
    const [logs, events] = await Promise.all([API.get('/agent/logs?limit=100'), API.get('/events')]);
    const logEl = document.getElementById('auditLogs');
    const evEl = document.getElementById('auditEvents');
    if (logEl) logEl.innerHTML = logs.length ? logs.map(l => `
      <div class="tlog"><div class="tlog-h"><span class="badge ${l.success ? 'b-ok' : 'b-danger'}">${l.success ? '成功' : '失败'}</span>
        <b>🔧 ${l.tool}</b><span class="muted">${l.mode} · ${l.role} · ${l.duration_ms}ms · ${l.created_at}</span></div>
        <div class="tlog-d">run_id <code>${l.run_id}</code> · 参数 <code>${esc(JSON.stringify(l.arguments)).slice(0, 120)}</code></div></div>`).join('')
      : '<div class="empty">暂无执行记录，去「智能体」页对话即可产生。</div>';
    if (evEl) evEl.innerHTML = events.length ? events.map(e => `
      <div class="row-item"><span class="ri-k">${e.created_at}</span>
        <span class="ri-v"><b>${esc(e.actor)}</b> · ${esc(e.action)}<br><span class="muted">${esc(e.detail)}</span></span></div>`).join('')
      : '<div class="empty">暂无事件。</div>';
  } catch (e) {
    toast('审计数据加载失败：' + e.message);
  }
}

/* ===== 推送人工确认闭环 ===== */
async function createPushSuggestion(id, channels) {
  const t = TENDERS.find(x => x.id === id);
  try {
    const r = await callTool('create_push_suggestion', {
      tender_id: id, channels: channels || ['飞书', '企业微信'],
      reason: `匹配度 ${t ? t.match.score : '-'} 分，按页面指令生成`
    });
    if (r.ok) {
      openDrawer('推送建议 · 待人工确认', `
        <div class="answer"><p><b>${esc(r.data.tender_title || t.title)}</b></p>
        <p>渠道：${(r.data.channels || []).join('、')}　状态：待 HR 确认</p>
        <p class="muted">${esc(r.data.message)}</p></div>
        <div class="btn-row">
          <button class="btn" onclick="confirmPush(${r.data.suggestion_id})">✓ 确认推送（HR 人工确认）</button>
          <button class="btn btn-line" onclick="discardPush(${r.data.suggestion_id})">忽略</button>
        </div>
        <p class="muted" style="margin-top:8px">※ 智能体不直接发送通知；确认后写入推送记录与审计事件（渠道为演示模拟）。</p>`);
    } else {
      toast('推送建议创建失败：' + r.error);
    }
  } catch (e) { toast('请求失败：' + e.message); }
}

async function confirmPush(sid) {
  try {
    const r = await API.post(`/push/suggestions/${sid}/confirm`, { role: 'hr', confirmed: true });
    toast(r.message);
    closeDrawer();
    await refreshBootstrap();
    go('radar');
  } catch (e) { toast('确认失败：' + e.message); }
}

async function discardPush(sid) {
  try {
    await API.post(`/push/suggestions/${sid}/discard`, { role: 'hr' });
    toast('已忽略该推送建议');
    closeDrawer();
    await refreshBootstrap();
    go('radar');
  } catch (e) { toast('操作失败：' + e.message); }
}

async function refreshBootstrap() {
  await loadBootstrap();
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    await loadBootstrap();
  } catch (e) {
    document.getElementById('view').innerHTML =
      `<div class="card"><h3>后端服务未就绪</h3><p class="muted">无法加载 /api/bootstrap：${esc(e.message)}。
       请先启动后端：在项目根目录执行 <code>.\\scripts\\start.ps1</code>，或
       <code>python -m uvicorn app.main:app --app-dir backend --port 8000</code> 后刷新本页。</p></div>`;
    return;
  }
  document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => {
    go(n.dataset.view);
    if (n.dataset.view === 'audit') loadAudit();
  }));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#todayChip').textContent = `${BOOT.today} · ${window.MODE === 'llm' ? 'LLM 模式' : '规则演示模式'}`;
  go('agent');
})();
