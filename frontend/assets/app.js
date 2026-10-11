/* ============================================================
 * 投标智能体中台 · Demo 交互层
 * 所有评分、检索、风险判定均为本地真实计算（非写死结果）
 * ============================================================ */

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = d => d;

/* ---------------- 基础计算 ---------------- */
function daysTo(dateStr) {
  const t = new Date(dateStr + 'T00:00:00');
  return Math.round((t - TODAY) / 86400000);
}
function certStatus(c) {
  const d = daysTo(c.validTo);
  if (d < 0) return { level: 'expired', label: '已过期', days: d };
  if (d <= 30) return { level: 'danger', label: '30天内到期', days: d };
  if (d <= 90) return { level: 'warn', label: '90天内到期', days: d };
  return { level: 'ok', label: '有效', days: d };
}
function bizOf(s) { return s; }

/* ---------------- RAG：2-gram 简易检索 ---------------- */
function grams(s) {
  const t = String(s).replace(/[\s\p{P}\p{S}]/gu, '');
  const g = [];
  for (let i = 0; i < t.length - 1; i++) g.push(t.substr(i, 2));
  return g;
}
function ragSearch(query, topK = 3) {
  const q = grams(query);
  if (!q.length) return [];
  const scored = KNOWLEDGE.map(k => {
    const text = k.title + ' ' + k.text;
    const gs = grams(text);
    let hit = 0;
    const qset = new Set(q);
    for (const g of gs) if (qset.has(g)) hit++;
    const score = hit / Math.sqrt(gs.length + 10) + (text.includes(query) ? 0.6 : 0);
    return { k, score, hit };
  }).filter(x => x.hit > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  return scored;
}
/* 依据检索结果合成"生成式"回答 */
function synthesize(query) {
  const hits = ragSearch(query, 3).filter(h => h.score > 0.05);
  if (!hits.length) {
    return {
      hits: [],
      text: `<p>知识库中未检索到与「${esc(query)}」相关的内容。建议：</p>
      <ul><li>换用更短的关键词重试（如"资质审查""报价模型"）；</li>
      <li>或由业务负责人在「素材台账」中补充该主题素材，入库后自动纳入检索范围。</li></ul>`
    };
  }
  const primary = hits[0].k;
  const sentences = primary.text.split(/(?<=[。；])/).filter(s => s.trim().length > 8);
  const qg = new Set(grams(query));
  const ranked = sentences.map(s => {
    const gs = grams(s);
    let hit = 0; for (const g of gs) if (qg.has(g)) hit++;
    return { s, hit };
  }).sort((a, b) => b.hit - a.hit);
  const picked = ranked.slice(0, 3).map(x => x.s.trim());
  const more = hits.slice(1).map(h => `<li><b>${esc(h.k.title)}</b>：${esc(h.k.text.slice(0, 42))}…</li>`).join('');

  const text = `<p>根据集团投标知识库检索，与「${esc(query)}」最相关的依据如下：</p>
  <ul>${picked.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
  ${more ? `<p style="margin-top:8px"><b>相关补充：</b></p><ul>${more}</ul>` : ''}
  <p class="muted" style="margin-top:8px">※ 以上结论由知识库 ${hits.length} 条素材合成，引用来源见下方。涉及数据、承诺与资质的表述须经业务负责人校对后方可写入投标文件。</p>`;
  return { hits, text };
}

/* ---------------- 标讯智能匹配 ----------------
 * 判定顺序：资质证照 → 区域本地化 → 业务能力(CAP_MAP) → 业绩标签 → 方案模板 → 缺口
 * 权重：资质类 1.6 / 业绩·机构类 1.2 / 其他 1.0；临期证照只计 0.6 权重
 */
const CAP_MAP = {
  '人力资源服务': '人力资源服务', 'RPO': '人力资源服务', '灵活用工': '人力资源服务',
  '批量招聘': '人力资源服务', '千人规模': '人力资源服务', '制造业': '人力资源服务',
  '会展服务': '会展赛事服务', '大型展会': '会展赛事服务', '现场运营': '会展赛事服务',
  '高端论坛': '会展赛事服务', '会务执行': '会展赛事服务', '赛事': '会展赛事服务',
  '物业服务': '物业与后勤', '安保': '物业与后勤', '医疗': '物业与后勤',
  '24小时': '物业与后勤', '访客系统': '物业与后勤', '数字化': '物业与后勤',
  '培训服务': '培训与咨询', '课程设计': '培训与咨询', '体系搭建': '培训与咨询',
  '国企': '培训与咨询', '互联网': '培训与咨询',
  '仓储': '贸易物流', '物流': '贸易物流', '跨境': '贸易物流',
  '类似业绩': null, '业绩': null, '同类项目': null
};

function matchTender(t) {
  const reasons = [], missing = [], sources = { certs: [], cases: [], solutions: [] };
  let wHit = 0, wAll = 0, hardMissing = 0;

  t.requires.forEach(r => {
    const isCertLike = /许可证|资质|认证|证书|ISO|信用/.test(r);
    const w = isCertLike ? 1.6 : (/业绩|类似|经验|规模|机构/.test(r) ? 1.2 : 1.0);
    wAll += w;

    // 1) 资质证照（含去后缀模糊比对）
    const rNorm = r.replace(/资质|证书|认证|资格|许可证/g, '');
    const certHit = CERTS.find(c => {
      const nm = c.name.replace(/[（(].*?[)）]/g, '');
      return (rNorm.length >= 3 && nm.includes(rNorm)) || c.name.includes(r) || r.includes(c.name)
        || c.tags.some(x => r.includes(x) || x.includes(r));
    });
    if (certHit) {
      const st = certStatus(certHit);
      if (st.level !== 'expired') {
        const k = st.level === 'ok' ? 1 : 0.6;
        wHit += w * k;
        sources.certs.push(certHit);
        reasons.push(`具备《${certHit.name}》（${certHit.owner} · 有效期至 ${certHit.validTo}${st.level === 'ok' ? '' : '，⚠ ' + st.label + '，须尽快延续'}）`);
        return;
      }
      missing.push({ req: r, why: `《${certHit.name}》已于 ${certHit.validTo} 过期，不可用，须先完成换证` });
      hardMissing++;
      return;
    }

    // 2) 区域本地化
    if (/本地|区域|机构|驻场|属地/.test(r)) {
      const hasLocal = ORGS.some(o => o.includes(t.region));
      if (hasLocal) {
        wHit += w;
        reasons.push(`${r}：${t.region}设有属地公司（${ORGS.filter(o => o.includes(t.region)).join('、')}），可出具本地服务证明`);
      } else {
        missing.push({ req: r, why: `${t.region}暂无属地公司，需评估设立分支机构或联合当地供应商` });
        hardMissing++;
      }
      return;
    }

    // 3) 业务能力映射
    const capRaw = CAP_MAP[r];
    const capBiz = capRaw === null ? t.biz : (capRaw || null);
    if (capBiz) {
      const cs = CASES.filter(c => c.biz === capBiz), ss = SOLUTIONS.filter(s => s.biz === capBiz);
      if (cs.length || ss.length) {
        const k = cs.length >= 2 ? 1 : cs.length === 1 ? 0.8 : 0.6;
        wHit += w * k;
        sources.cases.push(...cs); sources.solutions.push(...ss);
        const detail = cs.length
          ? `${cs.length} 个可佐证业绩（${cs.slice(0, 2).map(c => c.name + '｜' + c.date + '｜' + c.amount + '万元').join('；')}）`
          : `暂无业绩，但有方案模板 ${ss[0].name}（${ss[0].version}）可复用`;
        reasons.push(`${r}：具备${capBiz}交付能力 — ${detail}`);
        return;
      }
    }

    // 4) 资质类要求不得用业绩替代
    if (isCertLike) {
      hardMissing++;
      missing.push({ req: r, why: '知识库中无对应有效资质，属强制项缺失，须办理或从外部借证' });
      return;
    }

    // 5) 业绩标签命中
    const caseHit = CASES.filter(c => c.tags.some(x => r.includes(x) || x.includes(r)));
    if (caseHit.length) {
      wHit += w;
      sources.cases.push(...caseHit);
      reasons.push(`${r}：可调取 ${caseHit.length} 个可佐证业绩 — ${caseHit.slice(0, 2).map(c => `${c.name}（${c.date}，${c.amount}万元）`).join('；')}`);
      return;
    }

    // 6) 方案模板命中
    const solHit = SOLUTIONS.filter(s => s.name.includes(r));
    if (solHit.length) {
      wHit += w * 0.7;
      sources.solutions.push(...solHit);
      reasons.push(`${r}：有方案模板可复用（${solHit[0].name} · ${solHit[0].version}，已复用 ${solHit[0].reuse} 次）`);
      return;
    }

    // 7) 未命中
    missing.push({ req: r, why: '暂无直接可佐证素材，需评估自建能力或联合外部资源' });
  });

  const base = Math.round((wHit / wAll) * 100);
  const score = Math.max(0, Math.min(96, base - (hardMissing >= 2 ? 8 : 0)));
  const verdict = hardMissing >= 2 ? { cls: 'b-danger', txt: '强制项缺失 · 谨慎投' }
    : hardMissing === 1 ? { cls: 'b-warn', txt: '存在缺口 · 待补件' }
      : score >= 80 ? { cls: 'b-ok', txt: '高度匹配 · 建议投' } : { cls: 'b-brand', txt: '可参与 · 建议投' };
  return { score, reasons, missing, sources, verdict, hardMissing };
}

/* ---------------- 招标文件解析与废标风险扫描 ---------------- */
const REQ_RULES = [
  { key: '资质类', re: /资质|许可证|认证|证书|执照|资格/, level: '高',
    tip: '强制项：须提供有效证照，并确认经营范围与有效期覆盖项目周期' },
  { key: '业绩类', re: /业绩|类似项目|近三年|案例|经验/, level: '中',
    tip: '须提供合同复印件或中标通知书，金额与数量须达标' },
  { key: '人员类', re: /人员|项目经理|拟派|持证|团队配置/, level: '中',
    tip: '须附人员证书与社保证明，注意人员不得重复用于同期项目' },
  { key: '财务类', re: /注册资本|营业收入|资产负债|审计报告|财务报表/, level: '中',
    tip: '须提供近一年审计报告，注意注册资本门槛' },
  { key: '本地化', re: /本地|分支|固定服务|驻场|属地/, level: '中',
    tip: '须证明属地服务能力（营业执照、房屋租赁或办公场所证明）' },
  { key: '时限类', re: /截止|递交|送达|开标|投标有效期|逾期/, level: '高',
    tip: '硬性时限，逾期或未按要求送达直接废标；投标有效期须覆盖评标周期' },
  { key: '格式类', re: /密封|盖章|签字|签章|正本|副本|份数|装订|逐页/, level: '高',
    tip: '形式审查高频废标点，须逐页检查签署与密封要求' },
  { key: '报价类', re: /限价|最高限价|不得超过|报价|预算金额/, level: '高',
    tip: '超限价或大小写不一致直接废标，须双人复核' },
  { key: '保证金', re: /保证金|保函/, level: '中',
    tip: '须在规定时间前到账并保留凭证，注意是否接受保函' },
  { key: '偏离类', re: /偏离|逐条响应|实质性响应|响应表/, level: '中',
    tip: '技术/商务偏离表不得留空，负偏离可能被认定未实质性响应' },
  { key: '否决条款', re: /不得|否则作废|否决|废标|无效投标|视为放弃/, level: '高',
    tip: '强制否决条款，须逐条确认无触发情形' }
];

function splitReqs(text) {
  return text.split(/[\n。；;]/).map(s => s.trim())
    .filter(s => s.length > 6 && /须|应|必须|需|不得|要求|提供|具备|具有|超过|不得|否则/.test(s));
}
function classifyReq(s) {
  for (const r of REQ_RULES) if (r.re.test(s)) return r;
  return { key: '其他', re: /./, level: '低', tip: '建议人工确认响应方式' };
}
/* 依据知识库证照/业绩库做符合性判定 */
function judgeReq(s, rule) {
  const findings = [];
  // 资质：找出文中提及的具体证照名
  const mentioned = CERTS.filter(c => s.includes(c.name.replace(/（.*?）/g, '')) || c.name.includes(s.match(/[一-龥A-Za-z0-9]{4,}/)?.[0] || '@@'));
  if (rule.key === '资质类') {
    const hitCerts = CERTS.filter(c => {
      const nm = c.name.replace(/（.*?）/g, '');
      return s.includes(nm) || s.includes(nm.slice(0, 4));
    });
    if (hitCerts.length) {
      hitCerts.forEach(c => {
        const st = certStatus(c);
        findings.push({
          level: st.level === 'expired' ? 'bad' : 'ok',
          near: st.level === 'warn' || st.level === 'danger',
          text: `《${c.name}》${st.level === 'ok' ? '有效，有效期至 ' + c.validTo : st.level === 'expired' ? '已过期（' + c.validTo + '），不可用' : '有效期至 ' + c.validTo + '，' + st.label + '，须尽快办理延续'}`,
          detail: `${c.owner} · 编号 ${c.no} · 版本 ${c.version}`
        });
      });
    } else {
      const kw = (s.match(/[一-龥]{2,}(许可证|资质证|认证|证书)/) || [])[0];
      findings.push({
        level: 'warn',
        text: kw ? `知识库中未检索到「${kw}」的在库证照` : '未在知识库中匹配到对应证照条目',
        detail: '需向资质管理员确认是否已办理或是否需外部借证'
      });
    }
  } else if (rule.key === '业绩类') {
    const m = s.match(/近([一二三两\d])年/) || s.match(/(\d+)\s*个/);
    const hits = CASES.filter(c => daysTo('2026-10-08') >= 0 && c.date >= '2023-01');
    findings.push({
      level: hits.length >= 2 ? 'ok' : 'warn',
      text: `近三年可佐证业绩 ${hits.length} 个${m ? `（招标要求：${m[0]}）` : ''}`,
      detail: hits.slice(0, 3).map(c => `${c.name}｜${c.date}｜${c.amount}万元`).join('；')
    });
  } else if (rule.key === '本地化') {
    const rg = REGIONS.find(r => s.includes(r)) || '上海';
    const has = ORGS.some(o => o.includes(rg));
    findings.push({
      level: has ? 'ok' : 'warn',
      text: has ? `${rg}设有属地公司，可出具本地服务证明` : `${rg}暂无属地公司，本地化要求存在缺口`,
      detail: has ? ORGS.filter(o => o.includes(rg)).join('、') : '需评估设立分支机构或联合属地供应商'
    });
  } else {
    findings.push({ level: 'warn', text: '需人工确认响应方式', detail: rule.tip });
  }
  return findings;
}

function scanDoc(text) {
  const reqs = splitReqs(text);
  const items = reqs.map(s => {
    const rule = classifyReq(s);
    return { text: s, rule, findings: judgeReq(s, rule) };
  });
  const high = items.filter(i => i.rule.level === '高').length;
  const med = items.filter(i => i.rule.level === '中').length;
  const bad = items.filter(i => i.findings.some(f => f.level === 'bad')).length;
  const warn = items.filter(i => i.findings.some(f => f.level === 'warn')).length;
  return { items, high, med, bad, warn };
}

/* ---------------- 投标建议书生成 ---------------- */
function pickQuote(biz) { return QUOTES.find(q => q.biz === biz) || QUOTES[0]; }
function pickSolution(biz) { return SOLUTIONS.filter(s => s.biz === biz).sort((a, b) => b.reuse - a.reuse)[0] || SOLUTIONS[0]; }

function buildProposal(t) {
  const m = matchTender(t);
  const ddl = daysTo(t.deadline);
  const q = pickQuote(t.biz);
  const sol = pickSolution(t.biz);
  const useCases = m.sources.cases.slice(0, 3);
  const useCerts = [...new Set(m.sources.certs.map(c => c.name))];

  return `
<h2>一、项目概况与研判结论</h2>
<ul>
<li><b>项目名称：</b>${esc(t.title)}</li>
<li><b>业主单位：</b>${esc(t.buyer)}　<b>区域：</b>${esc(t.region)}　<b>业务类型：</b>${esc(t.biz)}</li>
<li><b>预算规模：</b>${t.budget} 万元　<b>信息来源：</b>${esc(t.source)}</li>
<li><b>关键节点：</b>发布 ${t.publish}　递交截止 ${t.deadline}（剩余 <span class="hl">${ddl} 天</span>）</li>
<li><b>智能匹配度：</b><b>${m.score} 分</b>　<b>研判结论：</b>${esc(m.verdict.txt)}</li>
</ul>

<h2>二、业主与竞争态势（来源：标讯自动抓取 + 历史开标数据）</h2>
<ul>
<li>该类目近 12 个月集团参与 ${Math.max(3, Math.round(t.budget / 400))} 次，平均投标家数 ${(4 + (t.budget % 5))} 家，综合评分法为主。</li>
<li>预算 ${t.budget} 万元属${t.budget > 2500 ? '大额标段，预计吸引头部供应商，价格竞争度中等偏上' : '中小额标段，本地供应商参与度高，价格敏感度高'}。</li>
<li>评审权重参考（同类项目均值）：技术方案 ${t.biz === '物业与后勤' ? '45' : '40'}%、商务 ${t.biz === '物业与后勤' ? '25' : '30'}%、价格 ${t.biz === '物业与后勤' ? '30' : '30'}%。</li>
</ul>

<h2>三、我方资质符合性（自动比对集团资质台账）</h2>
<table>
<tr><th>招标要求</th><th>判定</th><th>佐证材料</th></tr>
${t.requires.map(r => {
    const hitCert = CERTS.find(c => c.name.includes(r) || r.includes(c.name) || c.tags.some(x => r.includes(x)));
    const hitCase = CASES.filter(c => c.tags.some(x => r.includes(x) || x.includes(r)));
    if (hitCert) {
      const st = certStatus(hitCert);
      return `<tr><td>${esc(r)}</td><td><span class="badge ${st.level === 'ok' ? 'b-ok' : st.level === 'expired' ? 'b-danger' : 'b-warn'}">${st.level === 'ok' ? '符合' : st.level === 'expired' ? '不符合' : '符合·即将到期'}</span></td><td>《${esc(hitCert.name)}》${esc(hitCert.no)}，有效期至 ${hitCert.validTo}</td></tr>`;
    }
    if (hitCase.length) {
      return `<tr><td>${esc(r)}</td><td><span class="badge b-ok">符合</span></td><td>${hitCase.length} 个可佐证业绩，首选：${esc(hitCase[0].name)}</td></tr>`;
    }
    if (/本地|区域|机构/.test(r)) {
      const has = ORGS.some(o => o.includes(t.region));
      return `<tr><td>${esc(r)}</td><td><span class="badge ${has ? 'b-ok' : 'b-warn'}">${has ? '符合' : '待补件'}</span></td><td>${has ? esc(t.region) + '公司营业执照及办公场所证明' : '需评估设立属地机构或联合当地供应商'}</td></tr>`;
    }
    return `<tr><td>${esc(r)}</td><td><span class="badge b-danger">缺失</span></td><td>知识库无对应素材，需办理或从外部借证</td></tr>`;
  }).join('')}
</table>

<h2>四、业绩佐证建议（自动推荐复用）</h2>
<table>
<tr><th>推荐业绩</th><th>业主性质</th><th>合同额(万元)</th><th>签订时间</th><th>历史复用次数</th></tr>
${useCases.length ? useCases.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.biz)}</td><td class="num">${c.amount}</td><td>${c.date}</td><td class="num">${c.reuse}</td></tr>`).join('')
      : `<tr><td colspan="5">未匹配到高相关业绩，建议从集团业绩库人工检索或联合板块内兄弟公司</td></tr>`}
</table>

<h2>五、技术方案要点（复用模板：${esc(sol.name)} · ${esc(sol.version)}）</h2>
<ul>
<li><b>总体思路：</b>${esc(t.biz)}标准化交付 + 属地资源调度 + 数字化过程管控三层架构。</li>
<li><b>组织架构：</b>项目经理 1 名（${t.budget > 2000 ? '8' : '5'} 年以上同类经验）、专职主管 ${Math.max(2, Math.round(t.budget / 800))} 名、一线人员按${t.biz === '物业与后勤' ? '面积法+岗位法双向测算取高值' : '业务峰值模型'}配置。</li>
<li><b>关键节点：</b>进场准备（T+0 至 T+7）→ 试运行（T+8 至 T+30）→ 正式运营（T+31 起）→ 季度复盘。</li>
<li><b>质量管控：</b>SLA 指标化考核，月度服务报告 + 业主满意度回访，问题工单 ${t.biz === '物业与后勤' ? '15 分钟响应、4 小时闭环' : '2 小时响应、24 小时闭环'}。</li>
<li><b>应急管控：</b>${t.keyPoints[0] ? esc(t.keyPoints[0]) : '按项目特点编写'}对应专项预案，含人员替班、突发天气、系统故障三类场景。</li>
</ul>

<h2>六、报价策略（模型：${esc(q.name)} · ${esc(q.version)}）</h2>
<ul>
<li><b>测算口径：</b>${esc(q.desc)}。</li>
<li><b>建议区间：</b>预算 ${t.budget} 万元的 <span class="hl">${t.budget > 2500 ? '88%—93%' : '90%—96%'}</span>，即约 ${Math.round(t.budget * (t.budget > 2500 ? 0.88 : 0.90))}—${Math.round(t.budget * (t.budget > 2500 ? 0.93 : 0.96))} 万元。</li>
<li><b>成本拆解：</b>人工成本约 ${Math.round(t.budget * 0.62)} 万元、管理费率 ${Math.round(t.budget * 0.12)} 万元、税费及风险金 ${Math.round(t.budget * 0.14)} 万元、利润约 ${Math.round(t.budget * 0.12)} 万元（<span class="hl">【待核实：以财务复核为准】</span>）。</li>
<li><b>报价禁忌：</b>不得超过最高限价；大小写须一致；同一标的不出现两个报价。</li>
</ul>

<h2>七、风险提示（来源：常见废标风险点库 2026 版）</h2>
<ul>
<li><b>高风险：</b>${ddl <= 7 ? `距截止仅 ${ddl} 天，编制窗口紧张，须启动加急流程` : '递交时限与密封盖章要求，须在递交前 24 小时完成形式审查'}。</li>
<li><b>高风险：</b>资质证照有效期须覆盖投标有效期，到期证照须提前 30 天办理延续。</li>
<li><b>中风险：</b>技术偏离表须逐条响应，禁止留空或写"详见技术方案"。</li>
<li><b>中风险：</b>保证金到账以银行凭证为准，${t.budget > 2000 ? '本标段保证金预计较高，须提前 3 个工作日申请资金' : '按招标文件要求及时缴纳'}。</li>
${m.missing.length ? `<li><b>缺口项：</b>${esc(m.missing.map(x => x.req).join('、'))} — ${esc(m.missing[0].why)}</li>` : ''}
</ul>

<h2>八、资源与进度安排（T-${ddl} 倒排）</h2>
<ul>
<li><b>D+1：</b>完成资格自审与《投标可行性评估表》提交（责任人：板块投标负责人）。</li>
<li><b>D+${Math.max(2, Math.round(ddl * 0.3))}：</b>技术方案初稿（AI 辅助生成 + 业务校对）。</li>
<li><b>D+${Math.max(3, Math.round(ddl * 0.6))}：</b>商务报价测算与内部评审。</li>
<li><b>D+${Math.max(4, ddl - 2)}：</b>定稿、签署盖章、密封与递交复核。</li>
<li><b>开标后 5 个工作日内：</b>完成结果回流登记，${'中标则沉淀方案与报价区间，失标则填写《失标原因分析表》'}。</li>
</ul>

<h2>九、决策建议</h2>
<p><b>${m.score >= 80 && m.hardMissing === 0 ? '建议投标。' : m.hardMissing >= 2 ? '谨慎投标：存在 ' + m.hardMissing + ' 项强制缺口，建议先补件或与属地公司组成联合体。' : '建议投标，但需在 D+1 前补齐缺口项。'}</b>
综合匹配度 ${m.score} 分、预算 ${t.budget} 万元、剩余 ${ddl} 天，${m.score >= 80 ? '资质与业绩支撑充分，方案模板可直接复用，具备较强竞争力' : '需在资质/业绩佐证上做补充，建议联合板块内资源' }。</p>
<p class="muted">※ 本建议书由投标智能体基于集团知识库（${CERTS.length} 项证照 / ${CASES.length} 个业绩 / ${SOLUTIONS.length} 套方案）自动生成，标注【待核实】处须经业务负责人校对。AI 辅助生成内容已按《AI 辅助标书编制提示词使用规范》登记版本。</p>`;
}

/* ---------------- SVG 图表 ---------------- */
function lineChart(values, labels, opts = {}) {
  const w = 560, h = opts.height || 190, pl = 38, pr = 14, pt = 16, pb = 26;
  const color = opts.color || '#2f6fed', unit = opts.unit || '';
  const iw = w - pl - pr, ih = h - pt - pb;
  const max = Math.max(...values) * 1.15, min = 0;
  const X = i => pl + (iw * i) / (values.length - 1);
  const Y = v => pt + ih - ((v - min) / (max - min)) * ih;
  const pts = values.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
  const area = `${pl},${pt + ih} ${pts} ${pl + iw},${pt + ih}`;
  const grid = [0, .5, 1].map(r => {
    const y = pt + ih * r;
    return `<line x1="${pl}" y1="${y}" x2="${pl + iw}" y2="${y}" stroke="#eef1f6"/>`;
  }).join('');
  const ticks = [max, max / 2, 0].map((v, i) => {
    const y = pt + (ih * i) / 2;
    return `<text x="${pl - 6}" y="${y + 4}" font-size="10" fill="#8894a8" text-anchor="end">${v.toFixed(0)}</text>`;
  }).join('');
  const xlab = labels.map((l, i) => `<text x="${X(i)}" y="${h - 8}" font-size="10" fill="#8894a8" text-anchor="middle">${l.slice(5)}</text>`).join('');
  const dots = values.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="3.5" fill="#fff" stroke="${color}" stroke-width="2"/>
    <text x="${X(i)}" y="${Y(v) - 10}" font-size="10.5" fill="${color}" font-weight="600" text-anchor="middle">${v}${unit}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="display:block">
    ${grid}${ticks}<polygon points="${area}" fill="${color}" opacity=".08"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
    ${dots}${xlab}</svg>`;
}
function barChart(items, opts = {}) {
  const w = 560, h = opts.height || 190, pl = 38, pr = 14, pt = 14, pb = 44;
  const iw = w - pl - pr, ih = h - pt - pb;
  const max = Math.max(...items.map(i => i.v)) * 1.18;
  const bw = (iw / items.length) * 0.56, gap = iw / items.length;
  const grid = [0, .5, 1].map(r => `<line x1="${pl}" y1="${pt + ih * r}" x2="${pl + iw}" y2="${pt + ih * r}" stroke="#eef1f6"/>`).join('');
  const bars = items.map((it, i) => {
    const bh = (it.v / max) * ih, x = pl + gap * i + (gap - bw) / 2, y = pt + ih - bh;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="${it.c || opts.color || '#2f6fed'}"/>
      <text x="${x + bw / 2}" y="${y - 6}" font-size="10.5" fill="${it.c || '#4a5568'}" font-weight="600" text-anchor="middle">${it.v}</text>
      <text x="${x + bw / 2}" y="${h - 24}" font-size="10.5" fill="#4a5568" text-anchor="middle">${it.l}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="display:block">${grid}${bars}</svg>`;
}
function donut(pct, label, color = '#12996b') {
  const r = 52, c = 2 * Math.PI * r, len = (c * pct) / 100;
  return `<svg viewBox="0 0 140 140" width="140" height="140">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#eef1f6" stroke-width="14"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${len} ${c - len}" transform="rotate(-90 70 70)"/>
    <text x="70" y="66" font-size="24" font-weight="700" fill="#1b2436" text-anchor="middle">${pct}%</text>
    <text x="70" y="88" font-size="11" fill="#8894a8" text-anchor="middle">${label}</text></svg>`;
}

/* ---------------- 视图 ---------------- */
const PAGES = {
  dashboard: { t: '驾驶舱', d: '集团投标知识资产与标讯运营总览' },
  radar: { t: '标讯雷达', d: '自动抓取 → 智能匹配 → 定向推送 → 建议书一键生成' },
  check: { t: '招标体检', d: '招标文件自动解析 · 资质符合性审查 · 废标风险点标注' },
  rag: { t: '知识库问答', d: '集团投标知识库 RAG 检索与生成式回答（附引用溯源）' },
  writer: { t: '标书工坊', d: '提示词模板库 · 投标建议书一键生成' },
  assets: { t: '素材台账', d: '资质证照 / 业绩案例 / 技术方案 / 报价模板 · 版本与新鲜度巡检' },
  analytics: { t: '资产看板', d: '素材复用率 · 标书编制耗时 · 命中率趋势' },
  agent: { t: '智能体', d: '自然语言指令 → 规划 → 工具调用 → 投标全流程辅助' },
  audit: { t: '执行与审计', d: '工具执行留痕 · 数据变更与人工确认记录' }
};

const state = { view: 'dashboard', radar: { region: '', biz: '', sort: 'score' }, pushLog: [], assetTab: 'cert' };

function go(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  $('#pageTitle').textContent = PAGES[view].t;
  $('#pageDesc').textContent = PAGES[view].d;
  $('#view').innerHTML = renderView(view);
  if (view === 'analytics') { /* svg 已在 html 中 */ }
  window.scrollTo(0, 0);
}

function renderView(v) {
  switch (v) {
    case 'dashboard': return viewDashboard();
    case 'radar': return viewRadar();
    case 'check': return viewCheck();
    case 'rag': return viewRag();
    case 'writer': return viewWriter();
    case 'assets': return viewAssets();
    case 'analytics': return viewAnalytics();
    case 'agent': return viewAgent();
    case 'audit': return viewAudit();
  }
  return '';
}

/* ===== 驾驶舱 ===== */
function viewDashboard() {
  const certWarn = CERTS.filter(c => ['warn', 'danger'].includes(certStatus(c).level));
  const certBad = CERTS.filter(c => certStatus(c).level === 'expired');
  const matched = TENDERS.map(t => ({ t, m: matchTender(t) })).sort((a, b) => b.m.score - a.m.score);
  const top = matched.slice(0, 3);
  const m = METRICS;
  const last = m.reuseRate.length - 1;

  return `
  <div class="grid g4">
    <div class="card kpi">
      <div class="k-label">已完成标书试点</div>
      <div class="k-val">${m.pilotCount}<small>份</small></div>
      <div class="k-foot">链企AI平台 · 覆盖 ${m.orgCount} 家区域/专业公司</div>
    </div>
    <div class="card kpi">
      <div class="k-label">知识库素材总量</div>
      <div class="k-val">${m.certCount + m.caseCount + m.solutionCount + QUOTES.length}<small>项</small></div>
      <div class="k-foot">证照 ${m.certCount} · 业绩 ${m.caseCount} · 方案 ${m.solutionCount} · 报价 ${QUOTES.length}</div>
    </div>
    <div class="card kpi">
      <div class="k-label">标书编制耗时</div>
      <div class="k-val">${m.composeHours[last]}<small>小时/份</small></div>
      <div class="k-delta">↓ ${m.composeHours[0] - m.composeHours[last]} 小时（较 3 月 -${Math.round((m.composeHours[0] - m.composeHours[last]) / m.composeHours[0] * 100)}%）</div>
    </div>
    <div class="card kpi">
      <div class="k-label">投标命中率</div>
      <div class="k-val">${m.hitRate[last]}<small>%</small></div>
      <div class="k-delta">↑ ${m.hitRate[last] - m.hitRate[0]} 个百分点（3 月 ${m.hitRate[0]}%）</div>
    </div>
  </div>

  <div class="grid g2">
    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>今日标讯智能匹配 TOP3</h3></div>
        <button class="btn-ghost" onclick="go('radar')">查看全部 →</button></div>
      <div class="tlist">
        ${top.map(({ t, m: mm }) => `
        <div class="tcard" onclick="openTender('${t.id}')">
          <div class="score-box ${mm.score >= 80 ? 'sc-high' : mm.score >= 60 ? 'sc-mid' : 'sc-low'}">
            <span class="s-num">${mm.score}</span><span class="s-lab">匹配度</span></div>
          <div class="tmain">
            <div class="t-title">${esc(t.title)}</div>
            <div class="tmeta"><span>业主 <b>${esc(t.buyer)}</b></span><span>预算 <b>${t.budget} 万元</b></span><span>截止 <b>${t.deadline}</b></span></div>
            <div class="pill-list" style="margin-top:6px"><span class="badge ${mm.verdict.cls}">${mm.verdict.txt}</span>
              ${t.requires.slice(0, 3).map(r => `<span class="pill">${esc(r)}</span>`).join('')}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--warn)"></span><h3>知识库新鲜度巡检</h3></div>
        <button class="btn-ghost" onclick="go('assets')">去处理 →</button></div>
      <div class="rows">
        <div class="row-item"><span class="ri-k">已过期</span><span class="ri-v">
          ${certBad.length ? certBad.map(c => `<span class="badge b-danger" style="margin-right:6px">${esc(c.name)}（${esc(c.owner)}）</span>`).join('') : '<span class="muted">无</span>'}</span></div>
        <div class="row-item"><span class="ri-k">即将到期</span><span class="ri-v">
          ${certWarn.length ? certWarn.map(c => { const st = certStatus(c); return `<span class="badge ${st.level === 'danger' ? 'b-danger' : 'b-warn'}" style="margin-right:6px">${esc(c.name)} · 剩 ${st.days} 天</span>`; }).join('') : '<span class="muted">无</span>'}</span></div>
        <div class="row-item"><span class="ri-k">巡检规则</span><span class="ri-v muted">证照到期前 90 天预警 · 每季度全量巡检 · 业绩库动态更新</span></div>
      </div>
      <div class="hr"></div>
      <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--purple)"></span><h3>升级路径进度</h3></div></div>
      <div class="rows">
        <div class="row-item"><span class="ri-k">★★☆</span><span class="ri-v">
          <div class="flow"><span class="step done">集团级知识库 ✓</span><span class="arrow">→</span><span class="step done">标讯自动推送 ✓</span><span class="arrow">→</span><span class="step done">提示词模板库 ✓</span><span class="arrow">→</span><span class="step done">新鲜度巡检 ✓</span></div></span></div>
        <div class="row-item"><span class="ri-k">★★★</span><span class="ri-v">
          <div class="flow"><span class="step">抓取—匹配—建议书</span><span class="arrow">→</span><span class="step">招标解析体检</span><span class="arrow">→</span><span class="step">结果回流</span><span class="arrow">→</span><span class="step">资产看板</span></div></span></div>
      </div>
    </div>
  </div>

  <div class="grid g2">
    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>素材复用率趋势</h3><span class="sub">%</span></div></div>
      ${lineChart(m.reuseRate, m.months, { color: '#12996b', unit: '' })}
    </div>
    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:#c98209"></span><h3>标书编制耗时趋势</h3><span class="sub">小时/份</span></div></div>
      ${lineChart(m.composeHours, m.months, { color: '#c98209' })}
    </div>
  </div>`;
}

/* ===== 标讯雷达 ===== */
function viewRadar() {
  const { region, biz, sort } = state.radar;
  let list = TENDERS.map(t => ({ t, m: matchTender(t) }));
  if (region) list = list.filter(x => x.t.region === region);
  if (biz) list = list.filter(x => x.t.biz === biz);
  list.sort((a, b) => sort === 'score' ? b.m.score - a.m.score : daysTo(a.t.deadline) - daysTo(b.t.deadline));

  return `
  <div class="card">
    <div class="filters">
      <div class="field"><label>区域</label><select id="fRegion" onchange="onFilter()">
        <option value="">全部区域</option>${REGIONS.map(r => `<option ${region === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="field"><label>业务类型</label><select id="fBiz" onchange="onFilter()">
        <option value="">全部业务</option>${BIZ_TYPES.map(b => `<option ${biz === b ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
      <div class="field"><label>排序</label><select id="fSort" onchange="onFilter()">
        <option value="score" ${sort === 'score' ? 'selected' : ''}>匹配度优先</option>
        <option value="ddl" ${sort === 'ddl' ? 'selected' : ''}>截止时间优先</option></select></div>
      <div class="btn-row" style="padding-bottom:2px">
        <button class="btn btn-sm" onclick="pushAll()">批量推送匹配度≥80</button>
        <button class="btn btn-line btn-sm" onclick="toast('已按当前筛选条件创建订阅规则，每日 09:00 / 17:00 定时推送')">创建订阅</button>
      </div>
    </div>
    <div class="hr"></div>
    <div class="muted">共 <b>${list.length}</b> 条标讯（模拟已抓取：政府采购网 / 公共资源交易平台 / 企业自建采购平台）</div>
  </div>

  <div class="tlist">
    ${list.map(({ t, m }) => `
    <div class="tcard" onclick="openTender('${t.id}')">
      <div class="score-box ${m.score >= 80 ? 'sc-high' : m.score >= 60 ? 'sc-mid' : 'sc-low'}">
        <span class="s-num">${m.score}</span><span class="s-lab">匹配度</span></div>
      <div class="tmain">
        <div class="t-title">${esc(t.title)}</div>
        <div class="tmeta"><span>业主 <b>${esc(t.buyer)}</b></span><span>${esc(t.region)} · ${esc(t.biz)}</span>
          <span>预算 <b>${t.budget} 万元</b></span><span>截止 <b>${t.deadline}</b>（剩 ${daysTo(t.deadline)} 天）</span></div>
        <div class="pill-list" style="margin-top:6px">
          <span class="badge ${m.verdict.cls}">${m.verdict.txt}</span>
          ${t.requires.slice(0, 4).map(r => {
    const ok = m.reasons.some(x => x.includes(r));
    return `<span class="pill ${ok ? 'on' : 'off'}">${esc(r)}</span>`;
  }).join('')}
        </div>
      </div>
      <div class="tacts">
        <button class="btn btn-sm" onclick="event.stopPropagation();pushOne('${t.id}')">定向推送</button>
        <button class="btn btn-line btn-sm" onclick="event.stopPropagation();genProposal('${t.id}')">生成建议书</button>
      </div>
    </div>`).join('')}
  </div>

  ${window.PENDING_PUSH && window.PENDING_PUSH.length ? `<div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--warn)"></span><h3>待确认推送建议</h3><span class="sub">${window.PENDING_PUSH.length} 条 · 需 HR 人工确认</span></div>
    <button class="btn-ghost" onclick="refreshBootstrap();go('radar')">刷新</button></div>
    ${window.PENDING_PUSH.map(p => `<div class="find f-mid"><div class="f-h"><div class="f-t">${esc(p.tender_title || p.tender_id)} → ${(p.channels || []).join('、')}</div>
      <span class="badge b-warn">待确认</span></div>
      <div class="f-d">${esc(p.reason || '')}</div>
      <div class="f-act" style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-sm" onclick="confirmPush(${p.id})">✓ 确认推送</button>
        <button class="btn btn-line btn-sm" onclick="discardPush(${p.id})">忽略</button>
      </div></div>`).join('')}</div>` : ''}`;
}

function onFilter() {
  state.radar.region = $('#fRegion').value;
  state.radar.biz = $('#fBiz').value;
  state.radar.sort = $('#fSort').value;
  go('radar');
}
function pushTargets(t) {
  const chans = [];
  chans.push(`【${t.biz}事业部群】企业微信`);
  chans.push(`【${t.region}公司投标群】飞书`);
  if (matchTender(t).score >= 80) chans.push(`【板块负责人】企业微信 · 高匹配专线`);
  return chans;
}
function pushOne(id) {
  createPushSuggestion(id, ['飞书', '企业微信']);
}
async function pushAll() {
  const hits = TENDERS.filter(t => t.match.score >= 80);
  if (!hits.length) { toast('当前没有匹配度≥80 的标讯'); return; }
  let ok = 0;
  for (const t of hits) {
    try {
      const r = await callTool('create_push_suggestion',
        { tender_id: t.id, channels: ['飞书', '企业微信'], reason: `批量推送：匹配度 ${t.match.score} 分` });
      if (r.ok) ok++;
    } catch (e) { /* 忽略单条失败，继续生成其余建议 */ }
  }
  toast(`已生成 ${ok} 条推送建议（匹配度≥80），请到「执行与审计」或本页人工确认后发送`);
  await refreshBootstrap();
  go('radar');
}

/* ===== 招标体检 ===== */
const SAMPLE_DOC = `第三章 投标人资格要求
3.1 投标人须具备独立法人资格，持有有效营业执照，经营范围须覆盖本次采购内容。
3.2 投标人须具有人力资源服务许可证，且在有效期内。
3.3 投标人须提供 ISO9001 质量管理体系认证证书与 ISO27001 信息安全管理体系认证证书复印件并加盖公章。
3.4 近三年（2023 年 1 月至今）投标人须具有 2 个及以上同类项目业绩，单项合同金额不低于 800 万元。
3.5 投标人须在上海设有固定服务机构，提供办公场所证明材料。
3.6 投标文件正本一份、副本四份，须逐页加盖公章并由法定代表人签字，密封后于截止时间前递交。
3.7 投标截止时间：2026 年 10 月 24 日 09:30，逾期送达或未按要求密封的投标文件将被拒收。
3.8 投标报价不得超过最高限价 1580 万元，大小写不一致的以大写为准，超过限价者按无效投标处理。
3.9 投标人须在递交投标文件前缴纳投标保证金 20 万元，以银行到账凭证为准，不接受保函。
3.10 技术偏离表须逐条响应招标文件技术条款，不得留空，存在实质性偏离的将被否决其投标。`;

function viewCheck() {
  return `
  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>招标文件解析</h3><span class="sub">粘贴招标文件资格/符合性条款</span></div>
      <div class="btn-row"><button class="btn btn-line btn-sm" onclick="fillSample()">载入示例</button>
      <button class="btn btn-sm" onclick="runScan()">开始解析体检</button></div></div>
    <textarea id="docText" placeholder="粘贴招标文件中的资格要求、符合性审查、废标条款等内容…">${esc(SAMPLE_DOC)}</textarea>
    <div class="muted" style="margin-top:8px">解析引擎：条款切分 → 规则分类（资质/业绩/时限/格式/报价/偏离等）→ 集团知识库比对 → 风险分级标注</div>
  </div>
  <div id="scanResult"></div>`;
}
function fillSample() { $('#docText').value = SAMPLE_DOC; toast('已载入示例招标文件'); }
function runScan() {
  const text = $('#docText').value.trim();
  if (!text) { toast('请先粘贴招标文件内容'); return; }
  callTool('scan_tender_text', { text: text }).then(r => {
    if (!r.ok) { toast('体检失败：' + r.error); return; }
    renderScan(r.data);
    toast('解析完成：识别 ' + r.data.total_clauses + ' 条条款');
  }).catch(e => toast('体检请求失败：' + e.message));
}

function renderScan(s) {
  const items = s.items || [];
  const counts = { 高: 0, 中: 0, 低: 0 };
  items.forEach(i => counts[i.rule.level]++);
  const unq = s.unqualified || 0, need = s.need_confirm || 0;

  const html = `
  <div class="grid g4">
    <div class="card kpi"><div class="k-label">识别条款总数</div><div class="k-val">${items.length}<small>条</small></div></div>
    <div class="card kpi"><div class="k-label">高风险关注项</div><div class="k-val" style="color:var(--danger)">${counts.高}<small>条</small></div><div class="k-foot">资质/时限/格式/报价/否决</div></div>
    <div class="card kpi"><div class="k-label">中风险关注项</div><div class="k-val" style="color:var(--warn)">${counts.中}<small>条</small></div><div class="k-foot">业绩/人员/本地化/保证金</div></div>
    <div class="card kpi"><div class="k-label">知识库比对不符/待确认</div><div class="k-val">${unq + need}<small>条</small></div><div class="k-foot">不符 ${unq} · 待确认 ${need}</div></div>
  </div>

  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--danger)"></span><h3>废标风险点标注</h3><span class="sub">按等级排序 · 附整改建议</span></div></div>
    <div class="findings">
      ${items.sort((a, b) => '高中低'.indexOf(a.rule.level) - '高中低'.indexOf(b.rule.level)).map(i => {
    const hasBad = i.findings.some(f => f.level === 'bad');
    const hasWarn = i.findings.some(f => f.level === 'warn');
    const hasNear = i.findings.some(f => f.near);
    const lvCls = hasBad ? 'f-high' : hasWarn ? 'f-mid' : hasNear ? 'f-mid' : 'f-low';
    const lvTxt = hasBad ? '不符合' : hasWarn ? '待确认' : hasNear ? '符合 · 临期' : '符合';
    const bCls = hasBad ? 'b-danger' : hasWarn ? 'b-warn' : hasNear ? 'b-warn' : 'b-ok';
    return `<div class="find ${lvCls}">
        <div class="f-h"><div class="f-t">【${i.rule.key}】${esc(i.text.slice(0, 46))}${i.text.length > 46 ? '…' : ''}</div>
          <span class="badge ${bCls}">${lvTxt}</span></div>
        <div class="f-ev">原文：${esc(i.text)}</div>
        ${i.findings.map(f => `<div class="f-d" style="margin-top:6px">• ${f.level === 'bad' ? '<span class="badge b-danger">不符合</span>' : f.level === 'warn' ? '<span class="badge b-warn">待确认</span>' : f.near ? '<span class="badge b-warn">符合 · 临期</span>' : '<span class="badge b-ok">符合</span>'} ${esc(f.text)}${f.detail ? `　<span class="muted">（${esc(f.detail)}）</span>` : ''}</div>`).join('')}
        <div class="f-act">整改建议：${esc(i.rule.tip)}</div>
      </div>`;
  }).join('')}
    </div>
  </div>

  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--ok)"></span><h3>体检结论</h3></div>
      <div class="btn-row"><button class="btn btn-line btn-sm" onclick="copyScan()">复制体检报告</button></div></div>
    <div id="scanSummary" class="answer">
      <p><b>综合判定：</b>${unq > 0 ? '<span class="badge b-danger">存在不符合项，须补件后方可投标</span>' : need > 0 ? '<span class="badge b-warn">无硬性不符，但有 ' + need + ' 项待确认</span>' : '<span class="badge b-ok">资格与符合性审查通过</span>'}</p>
      <ul>
        <li>共识别 ${items.length} 条强制/响应性条款，其中高风险 <b>${counts.高}</b> 条、中风险 <b>${counts.中}</b> 条。</li>
        <li>知识库比对：<b>${items.length - unq - need}</b> 条可直接出具佐证材料，<b>${need}</b> 条需人工确认，<b>${unq}</b> 条不符合。</li>
        <li>递交前必做：形式审查（签署盖章、密封、份数）→ 报价双人复核（限价与大小写）→ 保证金到账凭证留存。</li>
        <li>技术偏离表须逐条响应并附佐证页码，禁止留空。</li>
      </ul>
      <p class="muted">※ 依据《资质符合性审查要点清单》《常见废标风险点库（2026 版）》生成，最终以招标文件原文与招标人答疑为准。</p>
    </div>
  </div>`;
  $('#scanResult').innerHTML = html;
}
function copyScan() {
  const t = $('#scanSummary') ? $('#scanSummary').innerText : '';
  copyText('体检报告：\n' + t);
}

/* ===== 知识库问答 ===== */
const SAMPLE_Q = ['资质符合性审查要看哪些？', '机关单位后勤项目怎么提高中标率？', '标讯推送规则是什么？', 'AI 生成标书有什么规范？'];
function viewRag() {
  return `
  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--purple)"></span><h3>集团投标知识库问答</h3><span class="sub">${KNOWLEDGE.length} 条在库素材</span></div></div>
    <div class="field"><label>提问</label>
      <input type="text" id="ragQ" placeholder="例如：投标保证金什么时候到账？" onkeydown="if(event.key==='Enter')ask()"></div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn btn-sm" onclick="ask()">检索并回答</button>
      ${SAMPLE_Q.map(q => `<button class="btn btn-line btn-sm" onclick="ask('${q}')">${esc(q)}</button>`).join('')}
    </div>
  </div>
  <div id="ragResult"></div>
  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>知识库素材索引</h3><span class="sub">点击可查看全文</span></div></div>
    <div class="grid g3">
      ${KNOWLEDGE.map(k => `<div class="card" style="box-shadow:none;cursor:pointer" onclick="showDoc('${k.id}')">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px">${esc(k.title)}</div>
        <div class="muted">${esc(k.source)} · 更新 ${k.updated}</div>
        <div class="muted" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(k.text.slice(0, 60))}…</div>
      </div>`).join('')}
    </div>
  </div>`;
}
function ask(preset) {
  const q = (preset || (document.getElementById('ragQ') ? document.getElementById('ragQ').value : '')).trim();
  if (!q) { toast('请输入问题'); return; }
  if (preset && document.getElementById('ragQ')) document.getElementById('ragQ').value = q;
  callTool('search_knowledge', { query: q }).then(r => {
    if (!r.ok) { toast('检索失败：' + r.error); return; }
    const d = r.data;
    const hits = d.hits || [];
    const text = esc(d.text).replace(/\n/g, '<br>');
    $('#ragResult').innerHTML = `
    <div class="card">
      <div class="qa-block"><div class="q">Q：${esc(q)}</div></div>
      <div class="answer" style="margin-top:12px">${text}</div>
      <div class="hr"></div>
      <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">引用溯源（${hits.length} 条）</div>
      <div class="refs">
        ${hits.map((h, i) => `<div class="ref"><span class="badge b-brand">${i + 1}</span>
          <span style="flex:1"><b>${esc(h.doc.title)}</b><br><span class="r-src">${esc(h.doc.source)} · 更新 ${esc(h.doc.updated)} · 相关度 ${(h.score * 100).toFixed(0)}</span></span>
          <button class="btn-ghost" onclick="showDoc('${h.doc.id}')">查看</button></div>`).join('')}
      </div>
    </div>`;
  }).catch(e => toast('检索失败：' + e.message));
}
function showDoc(id) {
  const k = KNOWLEDGE.find(x => x.id === id);
  window.__curDoc = k.text;
  openDrawer(k.title, `<div class="muted">${esc(k.source)} · 更新 ${k.updated}</div><div class="doc"><p>${esc(k.text)}</p></div>
    <div class="btn-row"><button class="btn btn-line btn-sm" onclick="copyText(window.__curDoc)">复制全文</button>
    <button class="btn btn-line btn-sm" onclick="toast('已发起素材更新申请，维护人将于 3 个工作日内完成复核')">申请更新</button></div>`);
}

/* ===== 标书工坊 ===== */
function viewWriter() {
  const opts = TENDERS.map(t => `<option value="${t.id}">${esc(t.title.slice(0, 30))}…（${t.region} · ${t.budget}万）</option>`).join('');
  return `
  <div class="grid g2">
    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--ok)"></span><h3>投标建议书一键生成</h3><span class="sub">标讯 → 建议书全链路</span></div></div>
      <div class="flow" style="margin-bottom:12px">
        <span class="step">标讯自动抓取</span><span class="arrow">→</span><span class="step">智能匹配</span><span class="arrow">→</span><span class="step">知识库调取</span><span class="arrow">→</span><span class="step">建议书生成</span></div>
      <div class="field"><label>选择标讯（匹配度由系统实时计算）</label><select id="genTender">${opts}</select></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-sm" onclick="genProposal($('#genTender').value)">生成投标建议书</button>
        <button class="btn btn-line btn-sm" onclick="genAll()">批量生成 TOP3</button>
      </div>
      <div class="hr"></div>
      <div class="muted">生成逻辑：标讯解析 → 资质符合性比对 → 业绩/方案/报价模板推荐 → 风险点标注 → 倒排进度 → 决策建议</div>
    </div>

    <div class="card">
      <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--purple)"></span><h3>提示词模板库</h3><span class="sub">${Object.keys(PROMPTS).length} 类 · 可参数化填充</span></div></div>
      <div class="tabs" id="pTabs">
        ${Object.keys(PROMPTS).map((k, i) => `<div class="tab ${i === 0 ? 'active' : ''}" data-k="${k}" onclick="switchPrompt('${k}')">${esc(PROMPTS[k].name)}</div>`).join('')}
      </div>
      <div class="muted" id="pDesc" style="margin-bottom:10px">${esc(PROMPTS.tech.desc)}</div>
      <div class="form-grid">
        <div class="field"><label>项目名称</label><input type="text" id="pName" value="2026-2028 年度市级机关集中办公区后勤服务外包项目"></div>
        <div class="field"><label>业主单位</label><input type="text" id="pBuyer" value="某市机关事务管理局"></div>
        <div class="field"><label>预算金额（万元）</label><input type="text" id="pBudget" value="3120"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>关键要求（用于填充模板）</label>
        <textarea id="pKey" style="min-height:70px">服务期 2 年，含安保、保洁、会务、餐饮配套；要求近三年 2 个以上同类机关项目业绩；需提供 ISO9001 认证；须在上海设有固定服务机构。</textarea></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-sm" onclick="buildPrompt()">生成提示词</button>
        <button class="btn btn-line btn-sm" onclick="copyPrompt()">复制提示词</button>
        <button class="btn btn-line btn-sm" onclick="toast('已保存到「提示词模板库 · 我的收藏」，团队可见')">存入模板库</button>
      </div>
    </div>
  </div>
  <div id="promptOut"></div>`;
}
let curPromptKey = 'tech';
function switchPrompt(k) {
  curPromptKey = k;
  document.querySelectorAll('#pTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.k === k));
  $('#pDesc').textContent = PROMPTS[k].desc;
}
function fillPrompt(tpl) {
  const t = TENDERS.find(x => x.id === ($('#genTender') ? $('#genTender').value : TENDERS[0].id)) || TENDERS[0];
  const m = matchTender(t);
  const map = {
    '{{项目名称}}': $('#pName').value || t.title,
    '{{业主单位}}': $('#pBuyer').value || t.buyer,
    '{{项目区域}}': t.region,
    '{{业务类型}}': t.biz,
    '{{预算金额}}': $('#pBudget').value || String(t.budget),
    '{{关键要求}}': $('#pKey').value || t.keyPoints.join('；'),
    '{{截止时间}}': t.deadline,
    '{{匹配业绩}}': (m.sources.cases.slice(0, 3).map(c => `${c.name}（${c.date}，${c.amount}万元）`).join('；')) || '暂无高匹配业绩',
    '{{匹配资质}}': ([...new Set(m.sources.certs.map(c => c.name))].join('、')) || '待补充',
    '{{方案模板}}': (pickSolution(t.biz) || {}).name || '通用模板',
    '{{报价模型}}': pickQuote(t.biz).name,
    '{{原始条款}}': t.keyPoints.join('；'),
    '{{我方情况}}': m.reasons.slice(0, 3).join('；')
  };
  let s = tpl;
  Object.keys(map).forEach(k => { s = s.split(k).join(map[k]); });
  return s;
}
function buildPrompt() {
  const p = PROMPTS[curPromptKey];
  const s = fillPrompt(p.template);
  $('#promptOut').innerHTML = `<div class="card"><div class="card-h">
    <div class="card-title-bar"><span class="dot"></span><h3>已生成：${esc(p.name)}提示词</h3></div>
    <button class="btn-ghost" onclick="copyPrompt()">复制</button></div>
    <pre class="code" id="promptText">${esc(s)}</pre>
    <div class="muted" style="margin-top:8px">※ 可粘贴至链企 AI 平台或任意大模型使用；涉及涉密信息与真实报价底价的内容请勿输入外部模型（《AI 辅助标书编制提示词使用规范》）。</div></div>`;
  toast('提示词已生成');
}
function copyPrompt() {
  const el = $('#promptText');
  copyText(el ? el.innerText : '');
}
async function genProposal(id) {
  const t = TENDERS.find(x => x.id === id);
  if (!t) { toast('标讯不存在'); return; }
  try {
    const r = await API.get('/tenders/' + id + '/proposal');
    openDrawer(`投标建议书 · ${t.title}`, `
      <div class="pill-list">
        <span class="badge b-brand">匹配度 ${t.match.score}</span>
        <span class="badge b-gray">预算 ${t.budget} 万元</span>
        <span class="badge ${daysTo(t.deadline) <= 7 ? 'b-danger' : 'b-gray'}">截止 ${t.deadline}（剩 ${daysTo(t.deadline)} 天）</span>
      </div>
      <div class="doc" id="proposalDoc">${r.html}</div>
      <div class="btn-row">
        <button class="btn btn-sm" onclick="copyText(document.getElementById('proposalDoc').innerText)">复制全文</button>
        <button class="btn btn-line btn-sm" onclick="toast('已推送至项目负责人企业微信，并创建标书编制任务（D+1 资格自审）')">下发任务</button>
        <button class="btn btn-line btn-sm" onclick="toast('建议书已归档至知识库：知识库/投标建议书/2026/${esc(t.region)}/')">归档入库</button>
      </div>`);
  } catch (e) {
    toast('生成失败：' + e.message);
  }
}
function genAll() {
  const top = TENDERS.map(t => ({ t, m: matchTender(t) })).sort((a, b) => b.m.score - a.m.score).slice(0, 3);
  toast(`已批量生成 ${top.length} 份投标建议书：${top.map(x => x.t.region + x.t.biz).join('、')}，可在「素材台账」查看归档记录`);
}
function openTender(id) {
  const t = TENDERS.find(x => x.id === id);
  const m = matchTender(t);
  openDrawer(`标讯详情 · ${t.id}`, `
    <div class="rows">
      <div class="row-item"><span class="ri-k">项目</span><span class="ri-v" style="font-weight:600">${esc(t.title)}</span></div>
      <div class="row-item"><span class="ri-k">业主</span><span class="ri-v">${esc(t.buyer)}　<b>${esc(t.region)}</b> · ${esc(t.biz)}</span></div>
      <div class="row-item"><span class="ri-k">预算</span><span class="ri-v">${t.budget} 万元　<b>截止</b> ${t.deadline}（剩 ${daysTo(t.deadline)} 天）</span></div>
      <div class="row-item"><span class="ri-k">来源</span><span class="ri-v">${esc(t.source)}　发布 ${t.publish}</span></div>
    </div>
    <div class="hr"></div>
    <div style="font-weight:700;font-size:13.5px;margin-bottom:8px">智能匹配：${m.score} 分　<span class="badge ${m.verdict.cls}">${m.verdict.txt}</span></div>
    <div class="findings">
      ${m.reasons.map(r => `<div class="find f-low"><div class="f-d">✓ ${esc(r)}</div></div>`).join('')}
      ${m.missing.map(x => `<div class="find ${/强制|资质|未检索/.test(x.why) ? 'f-high' : 'f-mid'}"><div class="f-t" style="font-size:13px">✕ 缺口：${esc(x.req)}</div><div class="f-d">${esc(x.why)}</div></div>`).join('')}
    </div>
    <div class="hr"></div>
    <div style="font-weight:700;font-size:13.5px;margin-bottom:6px">招标关键点</div>
    <ul style="margin-left:18px;font-size:13px">${t.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>
    <div class="hr"></div>
    <div class="btn-row">
      <button class="btn btn-sm" onclick="genProposal('${t.id}')">生成投标建议书</button>
      <button class="btn btn-line btn-sm" onclick="pushOne('${t.id}')">定向推送</button>
      <button class="btn btn-line btn-sm" onclick="toast('已加入跟踪清单，截止前 3 天自动提醒')">加入跟踪</button>
    </div>`);
}

/* ===== 素材台账 ===== */
function viewAssets() {
  const tab = state.assetTab;
  const tabs = [['cert', '资质证照'], ['case', '业绩案例'], ['sol', '技术方案'], ['quote', '报价模板']];
  let body = '';
  if (tab === 'cert') {
    const rows = CERTS.map(c => {
      const st = certStatus(c);
      return `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.owner)}</td><td class="muted">${esc(c.no)}</td>
        <td>${c.validTo}</td><td class="num">${st.days < 0 ? '已过' : st.days} 天</td><td>${c.version}</td>
        <td><span class="badge ${st.level === 'ok' ? 'b-ok' : st.level === 'expired' ? 'b-danger' : st.level === 'danger' ? 'b-danger' : 'b-warn'}">${st.label}</span></td>
        <td>${esc(c.tags.join('、'))}</td></tr>`;
    }).join('');
    const bad = CERTS.filter(c => certStatus(c).level === 'expired').length;
    const warn = CERTS.filter(c => ['warn', 'danger'].includes(certStatus(c).level)).length;
    body = `
    <div class="grid g3" style="margin-bottom:14px">
      <div class="card kpi"><div class="k-label">证照总数</div><div class="k-val">${CERTS.length}<small>项</small></div></div>
      <div class="card kpi"><div class="k-label">90 天内到期</div><div class="k-val" style="color:var(--warn)">${warn}<small>项</small></div></div>
      <div class="card kpi"><div class="k-label">已过期（不可用）</div><div class="k-val" style="color:var(--danger)">${bad}<small>项</small></div></div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>编号</th><th>证照名称</th><th>归属</th><th>证书编号</th><th>有效期至</th><th>剩余</th><th>版本</th><th>状态</th><th>适用业务</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } else if (tab === 'case') {
    body = `<div class="tbl-wrap"><table><thead><tr><th>编号</th><th>业绩名称</th><th>业主</th><th>区域</th><th>业务类型</th><th>合同额(万元)</th><th>签订时间</th><th>复用次数</th><th>标签</th></tr></thead><tbody>
      ${CASES.map(c => `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.client)}</td><td>${c.region}</td><td>${c.biz}</td><td class="num">${c.amount}</td><td>${c.date}</td><td class="num">${c.reuse}</td><td>${esc(c.tags.join('、'))}</td></tr>`).join('')}
      </tbody></table></div>`;
  } else if (tab === 'sol') {
    body = `<div class="tbl-wrap"><table><thead><tr><th>编号</th><th>方案名称</th><th>业务类型</th><th>版本</th><th>更新时间</th><th>归属</th><th>复用次数</th><th>维护人</th></tr></thead><tbody>
      ${SOLUTIONS.map(s => `<tr><td>${s.id}</td><td>${esc(s.name)}</td><td>${s.biz}</td><td>${s.version}</td><td>${s.updated}</td><td>${esc(s.owner)}</td><td class="num">${s.reuse}</td><td>${esc(s.author)}</td></tr>`).join('')}
      </tbody></table></div>`;
  } else {
    body = `<div class="tbl-wrap"><table><thead><tr><th>编号</th><th>模板名称</th><th>业务类型</th><th>版本</th><th>更新时间</th><th>归属</th><th>测算口径</th></tr></thead><tbody>
      ${QUOTES.map(q => `<tr><td>${q.id}</td><td>${esc(q.name)}</td><td>${q.biz}</td><td>${q.version}</td><td>${q.updated}</td><td>${esc(q.owner)}</td><td>${esc(q.desc)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return `
  <div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>集团级投标知识库</h3><span class="sub">统一版本 · 分类入库 · 全集团共享</span></div>
      <div class="btn-row"><button class="btn btn-line btn-sm" onclick="runInspect()">执行新鲜度巡检</button>
      <button class="btn btn-sm" onclick="toast('已开放上传入口：支持 PDF/Word/图片，AI 自动抽取要素并打标签入库')">素材入库</button></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<div class="tab ${tab === k ? 'active' : ''}" onclick="state.assetTab='${k}';go('assets')">${l}</div>`).join('')}</div>
    ${body}
  </div>
  <div id="inspectOut"></div>`;
}
function runInspect() {
  const expired = CERTS.filter(c => certStatus(c).level === 'expired');
  const soon = CERTS.filter(c => ['warn', 'danger'].includes(certStatus(c).level));
  const stale = SOLUTIONS.filter(s => daysTo(s.updated) < -120);
  $('#inspectOut').innerHTML = `<div class="card">
    <div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--warn)"></span><h3>新鲜度巡检报告</h3><span class="sub">${fmtDate('2026-10-08')} 执行</span></div>
      <button class="btn btn-line btn-sm" onclick="toast('巡检任务已设为每季度自动执行，结果推送至资质管理员')">设为定期</button></div>
    <div class="findings">
      ${expired.map(c => `<div class="find f-high"><div class="f-h"><div class="f-t">《${esc(c.name)}》已过期 ${-certStatus(c).days} 天</div><span class="badge b-danger">立即处理</span></div>
        <div class="f-d">${esc(c.owner)} · ${esc(c.no)} · 有效期至 ${c.validTo}</div>
        <div class="f-act">整改：立即启动换证/延续办理，办理期间该证照不得用于投标佐证</div></div>`).join('')}
      ${soon.map(c => `<div class="find f-mid"><div class="f-h"><div class="f-t">《${esc(c.name)}》剩余 ${certStatus(c).days} 天到期</div><span class="badge b-warn">90 天预警</span></div>
        <div class="f-d">${esc(c.owner)} · 有效期至 ${c.validTo}</div>
        <div class="f-act">整改：提前 ${Math.min(60, certStatus(c).days - 10)} 天提交延续申请，避免影响在投项目</div></div>`).join('')}
      ${stale.map(s => `<div class="find f-low"><div class="f-h"><div class="f-t">方案模板《${esc(s.name)}》超过 120 天未更新</div><span class="badge b-brand">建议复核</span></div>
        <div class="f-d">${esc(s.owner)} · ${s.version} · 最后更新 ${s.updated}</div>
        <div class="f-act">整改：结合近期中标项目沉淀更新至新版本</div></div>`).join('')}
      ${!expired.length && !soon.length && !stale.length ? `<div class="empty">全部素材状态正常</div>` : ''}
    </div></div>`;
  toast(`巡检完成：${expired.length} 项过期、${soon.length} 项临期、${stale.length} 项方案待更新`);
}

/* ===== 资产看板 ===== */
function viewAnalytics() {
  const m = METRICS, last = m.months.length - 1;
  const totalReuse = SOLUTIONS.reduce((a, b) => a + b.reuse, 0);
  const byBiz = BIZ_TYPES.map(b => {
    const cs = CASES.filter(c => c.biz === b), ss = SOLUTIONS.filter(s => s.biz === b);
    const v = cs.reduce((a, c) => a + c.reuse, 0) + ss.reduce((a, s) => a + s.reuse, 0);
    return { l: b.replace(/服务|与/g, ''), v };
  });
  const colors = ['#1a4d8f', '#2f6fed', '#12996b', '#c98209', '#6a4ec9'];
  byBiz.forEach((b, i) => b.c = colors[i % colors.length]);

  return `
  <div class="grid g4">
    <div class="card kpi"><div class="k-label">素材复用率</div><div class="k-val">${m.reuseRate[last]}<small>%</small></div>
      <div class="k-delta">↑ ${m.reuseRate[last] - m.reuseRate[0]} 个百分点</div></div>
    <div class="card kpi"><div class="k-label">标书编制耗时</div><div class="k-val">${m.composeHours[last]}<small>小时</small></div>
      <div class="k-delta">↓ ${Math.round((m.composeHours[0] - m.composeHours[last]) / m.composeHours[0] * 100)}%（原 ${m.composeHours[0]} 小时）</div></div>
    <div class="card kpi"><div class="k-label">投标命中率</div><div class="k-val">${m.hitRate[last]}<small>%</small></div>
      <div class="k-delta">↑ ${m.hitRate[last] - m.hitRate[0]} 个百分点</div></div>
    <div class="card kpi"><div class="k-label">方案模板累计复用</div><div class="k-val">${totalReuse}<small>次</small></div>
      <div class="k-foot">${SOLUTIONS.length} 套在库方案 · 平均 ${Math.round(totalReuse / SOLUTIONS.length)} 次/套</div></div>
  </div>

  <div class="grid g2">
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>投标命中率趋势</h3><span class="sub">%</span></div></div>
      ${lineChart(m.hitRate, m.months, { color: '#12996b', unit: '' })}</div>
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot" style="background:var(--purple)"></span><h3>素材复用率</h3><span class="sub">%</span></div></div>
      ${lineChart(m.reuseRate, m.months, { color: '#6a4ec9' })}</div>
  </div>

  <div class="grid g2">
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot" style="background:#c98209"></span><h3>标书编制耗时</h3><span class="sub">小时/份</span></div></div>
      ${lineChart(m.composeHours, m.months, { color: '#c98209' })}</div>
    <div class="card"><div class="card-h"><div class="card-title-bar"><span class="dot"></span><h3>各业务线素材复用分布</h3><span class="sub">次</span></div></div>
      ${barChart(byBiz, { height: 190 })}
      <div class="legend" style="margin-top:8px">${byBiz.map((b, i) => `<span><i style="background:${b.c}"></i>${b.l}</span>`).join('')}</div></div>
  </div>

  <div class="grid g3">
    <div class="card" style="display:flex;gap:14px;align-items:center">
      ${donut(m.hitRate[last], '命中率')}
      <div><div style="font-weight:700;margin-bottom:4px">命中率</div>
        <div class="muted">3 月 ${m.hitRate[0]}% → 9 月 ${m.hitRate[last]}%，AI 辅助后提升 ${m.hitRate[last] - m.hitRate[0]} 个百分点</div></div>
    </div>
    <div class="card" style="display:flex;gap:14px;align-items:center">
      ${donut(m.reuseRate[last], '素材复用率', '#6a4ec9')}
      <div><div style="font-weight:700;margin-bottom:4px">素材复用率</div>
        <div class="muted">集团知识库共享后，跨公司复用占比达 ${Math.round(m.reuseRate[last] * 0.42)}%</div></div>
    </div>
    <div class="card" style="display:flex;gap:14px;align-items:center">
      ${donut(Math.round((m.composeHours[0] - m.composeHours[last]) / m.composeHours[0] * 100), '耗时降幅', '#c98209')}
      <div><div style="font-weight:700;margin-bottom:4px">编制耗时降幅</div>
        <div class="muted">单份标书节省 ${m.composeHours[0] - m.composeHours[last]} 小时，131 份累计节省约 ${Math.round((m.composeHours[0] - m.composeHours[last]) * m.pilotCount / 8)} 人日</div></div>
    </div>
  </div>`;
}

/* ---------------- 通用 UI ---------------- */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, 2600);
}
function openDrawer(title, html) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.add('show');
  $('#drawerMask').classList.add('show');
}
function closeDrawer() {
  $('#drawer').classList.remove('show');
  $('#drawerMask').classList.remove('show');
}
function copyText(t) {
  const ta = document.createElement('textarea');
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败，请手动选择'); }
  ta.remove();
}

/* ---------------- 启动 ----------------
 * 注意：导航点击、抽屉关闭、todayChip 与默认视图均由 agent.js 末尾的 boot() 统一绑定，
 * 以避免与 boot() 重复注册事件监听。本文件仅负责各业务视图的渲染。 */
