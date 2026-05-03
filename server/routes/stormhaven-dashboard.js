// Stormhaven Mission Control — dashboard renderer (vanilla JS, no deps)
// Reads /api/stormhaven/state for snapshot, /api/stormhaven/stream for live updates,
// /api/stormhaven/cost-history?days=30 for cost trend chart.
// Spec: STORMHAVEN_BUILD_SPEC_v1.2.md §4.5 (eight panels).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, def = 0) => (v == null || v === 'null' || isNaN(v)) ? def : Number(v);
const fmt$ = (v) => '$' + num(v).toFixed(2);
const fmtKB = (v) => num(v).toLocaleString() + 'KB/s';
const ageS = (iso) => {
  if (!iso) return '?';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
};
const isoToDate = (iso) => {
  if (!iso) return '—';
  const d = (typeof iso === 'number') ? new Date(iso) : new Date(iso);
  return d.toISOString().slice(0,10);
};
const isoToHHMM = (iso) => {
  if (!iso) return '—';
  const d = (typeof iso === 'number') ? new Date(iso) : new Date(iso);
  return d.toISOString().slice(11,16) + 'Z';
};

let lastSnap = null;

// ═══════════════════════════════════════════════════════════════════════════
// Header strip
// ═══════════════════════════════════════════════════════════════════════════
function renderHeader(s) {
  const overall = s.stack.overall || 'GREEN';
  const reason = s.stack.overallReason || '';
  const today = num(s.openclaw?.today?.estimatedCostUSD);
  const mtd = num(s.openclaw?.mtd?.estimatedCostUSD);
  const projected = num(s.openclaw?.projectedMonthCostUSD);
  const overBudget = projected > 25 ? '<span class="over-budget"> ⚠ over budget</span>' : '';
  const sok = s.collector?.sourcesOk || 0;
  const sfail = s.collector?.sourcesFailed || 0;
  const ms = s.collector?.elapsedMs || 0;
  const gw = s.openclaw?.gateway?.version || 'unknown';
  $('header').innerHTML = `
    <div class="banner ${overall}">
      <div class="row">
        <div>
          <span class="status-word">${overall}</span>
          <span style="font-size:14px;color:var(--text);margin-left:10px">${esc(reason)}</span>
          <div class="meta" style="margin-top:6px">
            Last collector ${ageS(s.generatedAt)}s ago • ${sok}/${sok+sfail} sources OK • ${(ms/1000).toFixed(1)}s elapsed
            • gateway ${esc(gw)}
          </div>
        </div>
        <div class="cost-strip" style="text-align:right">
          <div><span class="lab">today</span><span class="num">${fmt$(today)}</span></div>
          <div><span class="lab">MTD</span><span class="num">${fmt$(mtd)}</span></div>
          <div><span class="lab">projected</span><span class="num">${fmt$(projected)}</span>${overBudget}</div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Disk gauges
// ═══════════════════════════════════════════════════════════════════════════
function renderDisks(s) {
  $('disks').innerHTML = (s.disks || []).map(d => {
    const cls = d.usedPct > 95 ? 'RED' : d.usedPct > 80 ? 'YELLOW' : 'GREEN';
    let trendHtml;
    if ((d.trend?.samplesAvailable || 0) < 60) {
      trendHtml = `<div class="meta trend-pending">trend pending — needs 24h of history (${d.trend?.samplesAvailable || 0}/1440 samples)</div>`;
    } else {
      const delta = d.trend.deltaUsedGB24h;
      const proj = d.trend.projectedDaysToCritical95;
      const projTxt = proj == null ? 'no growth' : (proj === 0 ? 'past 95%!' : `${proj}d to 95%`);
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      trendHtml = `<div class="meta">${arrow} ${Math.abs(delta)}GB/24h • ${projTxt}</div>`;
    }
    return `<div class="disk-card ${cls}">
      <div class="row"><span class="mono">${esc(d.mount)}</span><span class="disk-pct">${d.usedPct}%</span></div>
      <div class="meta">${esc(d.purpose || '')}</div>
      <div class="disk-bar"><div class="disk-bar-fill ${cls}" style="width:${d.usedPct}%"></div></div>
      <div class="meta">${d.usedGB} / ${d.totalGB} GB (${d.freeGB} free)</div>
      ${trendHtml}
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// ARR queues — 9-row tight list per spec §4.5 line 910
// ═══════════════════════════════════════════════════════════════════════════
function renderArr(s) {
  const rows = [];
  const a = s.arr || {};

  const arrRow = (name, d, hint) => {
    if (!d) return `<tr><td>${name}</td><td colspan="4" class="meta">no data</td></tr>`;
    const idx = num(d.indexerCount, 0);
    const idxCls = idx === 0 ? 'YELLOW' : (d.indexerHealth === 'ok' ? 'GREEN' : 'YELLOW');
    return `<tr>
      <td><strong>${name}</strong>${hint?` <span class="meta">${hint}</span>`:''}</td>
      <td class="num">${num(d.queueCount)}</td>
      <td class="num">${num(d.missingCount)}</td>
      <td class="num">${num(d.wantedCount)}</td>
      <td class="num"><span class="pill ${idxCls}">${idx}</span></td>
    </tr>`;
  };

  rows.push(arrRow('Radarr',  a.radarr));
  rows.push(arrRow('Sonarr',  a.sonarr));
  rows.push(arrRow('Lidarr',  a.lidarr));

  const p = s.prowlarr || {};
  const pWarns = (p.indexerWarnings || []).length;
  const pCls = pWarns > 0 ? 'YELLOW' : 'GREEN';
  rows.push(`<tr${pWarns?' class="unhealthy"':''}>
    <td><strong>Prowlarr</strong> ${pWarns?`<span class="meta">${pWarns} warning(s)</span>`:''}</td>
    <td class="num" colspan="3">${pWarns? esc((p.indexerWarnings[0].name||'')+' '+(p.indexerWarnings[0].msg||'')) :'OK'}</td>
    <td class="num"><span class="pill ${pCls}">${num(p.indexerCount)}</span></td>
  </tr>`);

  const b = s.bazarr || {};
  const bHealthy = b.healthy === true;
  rows.push(`<tr${bHealthy?'':' class="unhealthy"'}>
    <td><strong>Bazarr</strong> <span class="meta">${b.providersCount||0} providers · sonarr=${b.sonarrLinked?'✓':'✗'} · radarr=${b.radarrLinked?'✓':'✗'} · lp=${b.languageProfiles||0}</span></td>
    <td class="num" colspan="3">${bHealthy?'healthy':'⚠ setup gap'}</td>
    <td class="num"><span class="pill ${bHealthy?'GREEN':'YELLOW'}">${bHealthy?'OK':'!'}</span></td>
  </tr>`);

  const q = s.qbittorrent || {};
  rows.push(`<tr>
    <td><strong>qBittorrent</strong> <span class="meta">${num(q.active)} active · ${num(q.seeding)} seeding</span></td>
    <td class="num" colspan="3">↓ ${fmtKB(q.downKBs)} · ↑ ${fmtKB(q.upKBs)}</td>
    <td class="num"><span class="pill GREEN">VPN</span></td>
  </tr>`);

  const js = s.jellyseerr || {};
  rows.push(`<tr>
    <td><strong>Jellyseerr</strong></td>
    <td class="num" title="total">${num(js.totalRequests)}</td>
    <td class="num" title="pending">${num(js.pending)}</td>
    <td class="num" title="processing">${num(js.processing)}</td>
    <td class="num"><span class="pill GREEN">OK</span></td>
  </tr>`);

  const jf = s.jellyfin || {};
  const xc = jf.transcodeWarning ? `<span class="transcode-chip" title="${esc(jf.transcodeWarning)}">⚠ XCODE</span>` : '';
  rows.push(`<tr>
    <td><strong>Jellyfin</strong> <span class="meta">v${esc(jf.version||'?')}</span> ${xc}</td>
    <td class="num" colspan="3">${num(jf.activeStreams)} streams · ${num(jf.transcodeCount)} transcoding · ${num(jf.users)} users</td>
    <td class="num"><span class="pill GREEN">OK</span></td>
  </tr>`);

  const sab = s.sabnzbd || {};
  const sabCls = sab.configured ? 'GREEN' : 'YELLOW';
  rows.push(`<tr>
    <td><strong>SABnzbd</strong> ${sab.configured?'':'<span class="meta">not configured</span>'}</td>
    <td class="num" colspan="3">queue: ${num(sab.queue)}</td>
    <td class="num"><span class="pill ${sabCls}">${sab.configured?'OK':'!'}</span></td>
  </tr>`);

  $('arr').innerHTML = `
    <h2 class="panel-title">*ARR + Media services</h2>
    <table class="arr">
      <thead><tr><th>Service</th><th class="num">Q</th><th class="num">Missing</th><th class="num">Wanted</th><th class="num">Indexers</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Container grid + SVG NetNS dependency line
// ═══════════════════════════════════════════════════════════════════════════
function renderContainers(s) {
  const dangling = s.dependencies?.gluetunQbtNetns?.dangling;
  const danglingAlert = s.dependencies?.gluetunQbtNetns?.alert;
  $('containers').innerHTML = `
    <h2 class="panel-title">Containers (${(s.containers||[]).length})</h2>
    <div class="container-grid" id="container-grid">
      ${(s.containers||[]).map(c => {
        const isQbt = c.name === 'qbittorrent';
        const isGluetun = c.name === 'gluetun';
        const stateCls = c.state === 'running' ? 'state-running' : c.state === 'exited' ? 'state-exited' : 'state-other';
        const danglingCls = isQbt && dangling ? 'dangling' : '';
        const tip = (isQbt && danglingAlert) ? danglingAlert : (c.pinReason || '');
        return `<div class="container ${danglingCls}" data-name="${esc(c.name)}" title="${esc(tip)}">
          <div class="row"><span class="name">${esc(c.name)}</span>${c.pinned?'<span class="pin">📌</span>':''}</div>
          <div class="${stateCls}">${esc(c.state)}</div>
          ${isQbt && dangling ? '<div style="color:var(--red);font-size:10px;margin-top:3px">Dangling NetNS</div>' : ''}
        </div>`;
      }).join('')}
    </div>
    <svg class="dependency-line" id="dep-line"></svg>
    ${dangling ? `<div class="meta" style="margin-top:8px;color:var(--red)">⚠ ${esc(danglingAlert||'')}</div>` : ''}
  `;
  // Draw the line AFTER layout settles
  requestAnimationFrame(drawDependencyLine);
}

function drawDependencyLine() {
  const wrap = $('containers');
  const grid = $('container-grid');
  const svg = $('dep-line');
  if (!wrap || !grid || !svg) return;
  const gluetun = grid.querySelector('[data-name="gluetun"]');
  const qbt = grid.querySelector('[data-name="qbittorrent"]');
  if (!gluetun || !qbt) { svg.innerHTML = ''; return; }
  const wrapRect = wrap.getBoundingClientRect();
  const gRect = gluetun.getBoundingClientRect();
  const qRect = qbt.getBoundingClientRect();
  const gx = gRect.left - wrapRect.left + gRect.width / 2;
  const gy = gRect.top  - wrapRect.top  + gRect.height / 2;
  const qx = qRect.left - wrapRect.left + qRect.width / 2;
  const qy = qRect.top  - wrapRect.top  + qRect.height / 2;
  const dangling = lastSnap?.dependencies?.gluetunQbtNetns?.dangling;
  const stroke = dangling ? 'var(--red)' : 'var(--teal)';
  const dasharray = dangling ? '4,4' : '';
  // Curve via midpoint with offset
  const midX = (gx + qx) / 2;
  const midY = (gy + qy) / 2 - 30;
  svg.setAttribute('width', wrapRect.width);
  svg.setAttribute('height', wrapRect.height);
  svg.style.width = wrapRect.width + 'px';
  svg.style.height = wrapRect.height + 'px';
  svg.innerHTML = `
    <path d="M ${gx} ${gy} Q ${midX} ${midY} ${qx} ${qy}"
          stroke="${stroke}" stroke-width="2" fill="none"
          ${dasharray ? `stroke-dasharray="${dasharray}"` : ''}/>
    <circle cx="${gx}" cy="${gy}" r="3" fill="${stroke}"/>
    <circle cx="${qx}" cy="${qy}" r="3" fill="${stroke}"/>
  `;
}
window.addEventListener('resize', drawDependencyLine);

// ═══════════════════════════════════════════════════════════════════════════
// Setup gaps with Dismiss for 24h + Show fix
// ═══════════════════════════════════════════════════════════════════════════
const STACK_BASE_URL = 'https://github.com/rafe-walker/stormhaven-openclaw/blob/main/STACK.md';
function isDismissed(id) {
  try {
    const v = localStorage.getItem('storm-dismiss-' + id);
    return v && Number(v) > Date.now();
  } catch { return false; }
}
function dismissGap(id) {
  try { localStorage.setItem('storm-dismiss-' + id, String(Date.now() + 24*60*60*1000)); } catch {}
  if (lastSnap) renderSetupGaps(lastSnap);
}
function showFix(id, msg) {
  // Try to extract STACK.md §10.x reference from msg
  const m = (msg || '').match(/STACK\.md\s+§([\d.]+)/);
  const url = m ? `${STACK_BASE_URL}#${m[1].replace(/\./g,'')}` : STACK_BASE_URL;
  window.open(url, '_blank');
}
window._stormDismiss = dismissGap;
window._stormShowFix = showFix;

function renderSetupGaps(s) {
  const all = s.setupGaps || [];
  const visible = all.filter(g => !isDismissed(g.id));
  const hiddenCount = all.length - visible.length;
  if (visible.length === 0) {
    $('setup-gaps').innerHTML = `
      <h2 class="panel-title">Setup gaps</h2>
      <div class="meta">No active setup gaps${hiddenCount ? ` (${hiddenCount} dismissed)` : ''}</div>`;
    return;
  }
  $('setup-gaps').innerHTML = `
    <h2 class="panel-title">Setup gaps (${visible.length}${hiddenCount ? ` of ${all.length}` : ''})</h2>
    <ul class="gaps">
      ${visible.map(g => `
        <li>
          <div class="gap-dot ${esc(g.severity || 'info')}"></div>
          <div class="gap-body">
            <div><strong>${esc(g.service || '?')}</strong> · ${esc(g.msg || '')}</div>
            <div class="gap-actions">
              <button onclick="_stormDismiss('${esc(g.id)}')">Dismiss for 24h</button>
              <a onclick="_stormShowFix('${esc(g.id)}', ${JSON.stringify(g.msg||'').replace(/"/g,'&quot;')}); return false;" href="#">Show fix →</a>
            </div>
          </div>
        </li>`).join('')}
    </ul>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Recent runs strip — Hestia health dots (left) + Morning briefs (right, 7 horizontal)
// ═══════════════════════════════════════════════════════════════════════════
function renderRecentRuns(s) {
  const runs = s.openclaw?.hestiaHealthRuns24h || [];
  const dots = runs.slice(-96).map((r, i) =>
    `<span class="health-dot ${r.outcome}" data-run-idx="${runs.length - 96 + i < 0 ? i : runs.length - 96 + i}"
           title="${isoToHHMM(r.at)} • ${r.outcome} • ${(num(r.durationMs)/1000).toFixed(1)}s — click for details"
           onclick="_stormShowRun(${runs.length - 96 + i < 0 ? i : runs.length - 96 + i})"></span>`
  ).join('');

  const briefs = s.openclaw?.morningBriefs7d || [];
  // Build last-7-days array (Mon...Sun-style horizontal layout)
  const cards = [];
  const today = new Date(); today.setUTCHours(0,0,0,0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const dStr = d.toISOString().slice(0,10);
    const match = briefs.find(b => isoToDate(b.at) === dStr);
    if (match) {
      cards.push(`<div class="brief-card" onclick="_stormShowBrief(${briefs.indexOf(match)})">
        <div class="date">${dStr.slice(5)}</div>
        <div class="cost">${fmt$(match.estimatedCostUSD)}</div>
        <div class="snip">${esc((match.summarySnippet||'').slice(0,140))}</div>
      </div>`);
    } else {
      cards.push(`<div class="brief-card empty">
        <div class="date">${dStr.slice(5)}</div>
        <div class="cost">—</div>
        <div class="snip">no brief</div>
      </div>`);
    }
  }

  $('recent-runs').innerHTML = `
    <h2 class="panel-title">Hestia health (last 24h)</h2>
    <div class="health-dots">${dots || '<span class="meta">no runs yet</span>'}</div>
    <div class="meta" style="margin-top:6px">${runs.length} runs in window · click a dot for full output</div>

    <h2 class="panel-title" style="margin-top:14px">Morning briefs (last 7 days)</h2>
    <div class="briefs-row">${cards.join('')}</div>
  `;
}

window._stormShowRun = function(idx) {
  const r = (lastSnap?.openclaw?.hestiaHealthRuns24h || [])[idx];
  if (!r) return;
  // Try to fetch the full run detail from the server; fall back to what we have
  fetch('/api/stormhaven/run/' + encodeURIComponent(r.runId || r.id || idx))
    .then(rsp => rsp.ok ? rsp.json() : null)
    .catch(() => null)
    .then(detail => {
      const body = detail
        ? (detail.summary || detail.text || JSON.stringify(detail, null, 2))
        : `Hestia health run @ ${r.at}\n\nOutcome: ${r.outcome}\nDuration: ${(num(r.durationMs)/1000).toFixed(1)}s\n\n(Full run text not available — only summaries are persisted in the cron log.)`;
      $('modal-title').textContent = `Hestia health run · ${isoToHHMM(r.at)} · ${r.outcome}`;
      $('modal-body').textContent = body;
      $('modal').classList.add('open');
    });
};
window._stormShowBrief = function(idx) {
  const b = (lastSnap?.openclaw?.morningBriefs7d || [])[idx];
  if (!b) return;
  $('modal-title').textContent = `Morning brief · ${isoToDate(b.at)} · ${fmt$(b.estimatedCostUSD)}`;
  $('modal-body').textContent = b.summarySnippet || '(no snippet)';
  $('modal').classList.add('open');
};

// ═══════════════════════════════════════════════════════════════════════════
// Cost trend — 30 day SVG line chart with $0.83/day reference line
// ═══════════════════════════════════════════════════════════════════════════
let costSeries = null;
async function loadCostTrend() {
  try {
    const r = await fetch('/api/stormhaven/cost-history?days=30');
    if (!r.ok) throw new Error('http ' + r.status);
    costSeries = await r.json();
  } catch (e) {
    costSeries = [];
  }
  renderCostTrend();
}

function renderCostTrend() {
  // Build a 30-day window. Backfill with synthetic point from snapshot's MTD
  // so the chart is never empty even before first nightly rollup.
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const dStr = d.toISOString().slice(0,10);
    days.push({date: dStr, costUSD: 0});
  }
  // Merge in real rollup data
  (costSeries || []).forEach(p => {
    const idx = days.findIndex(d => d.date === p.date);
    if (idx >= 0) days[idx].costUSD = num(p.costUSD);
  });
  // If we have today's MTD running cost from snapshot but no rollup yet for today, plot it as today's value
  const todayCost = num(lastSnap?.openclaw?.today?.estimatedCostUSD);
  if (todayCost > 0 && days[days.length-1].costUSD === 0) {
    days[days.length-1].costUSD = todayCost;
  }

  const W = 700, H = 160, PAD_L = 38, PAD_R = 12, PAD_T = 12, PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const maxY = Math.max(1.0, ...days.map(d => d.costUSD), 0.83 * 1.2);
  const xFor = i => PAD_L + (i / (days.length - 1)) * innerW;
  const yFor = v => PAD_T + innerH - (v / maxY) * innerH;
  const refY = yFor(0.83);

  const linePath = days.map((d,i) => `${i===0?'M':'L'} ${xFor(i).toFixed(1)} ${yFor(d.costUSD).toFixed(1)}`).join(' ');
  const areaPath = linePath + ` L ${xFor(days.length-1).toFixed(1)} ${yFor(0).toFixed(1)} L ${xFor(0).toFixed(1)} ${yFor(0).toFixed(1)} Z`;

  const ticks = [0, maxY/4, maxY/2, 3*maxY/4, maxY].map(v => `
    <line x1="${PAD_L}" y1="${yFor(v).toFixed(1)}" x2="${(W-PAD_R).toFixed(1)}" y2="${yFor(v).toFixed(1)}" stroke="#1f2733" stroke-width="0.5"/>
    <text x="${PAD_L-4}" y="${(yFor(v)+3).toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="end">$${v.toFixed(2)}</text>
  `).join('');

  // X labels every 5 days
  const xLabels = days.map((d,i) => {
    if (i % 5 !== 0 && i !== days.length-1) return '';
    return `<text x="${xFor(i).toFixed(1)}" y="${(H-PAD_B+14).toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="middle">${d.date.slice(5)}</text>`;
  }).join('');

  const totalToDate = days.reduce((sum, d) => sum + d.costUSD, 0);

  $('cost-trend').innerHTML = `
    <div class="row">
      <h2 class="panel-title" style="margin-bottom:0">Cost trend — last 30 days</h2>
      <div class="meta">total $${totalToDate.toFixed(2)} · projected month-end ${fmt$(num(lastSnap?.openclaw?.projectedMonthCostUSD))}</div>
    </div>
    <div class="cost-trend-wrap">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${ticks}
        <path d="${areaPath}" fill="rgba(59,130,246,.12)"/>
        <path d="${linePath}" fill="none" stroke="var(--blue)" stroke-width="1.6"/>
        <line x1="${PAD_L}" y1="${refY.toFixed(1)}" x2="${(W-PAD_R).toFixed(1)}" y2="${refY.toFixed(1)}"
              stroke="var(--yellow)" stroke-width="1" stroke-dasharray="4,4"/>
        <text x="${(W-PAD_R-3).toFixed(1)}" y="${(refY-3).toFixed(1)}" fill="var(--yellow)" font-size="10" text-anchor="end">$0.83/day budget</text>
        ${xLabels}
        ${days.map((d,i) => d.costUSD > 0 ? `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(d.costUSD).toFixed(1)}" r="2" fill="var(--blue)"/>` : '').join('')}
      </svg>
    </div>
    <div class="legend">
      <span><span class="swatch" style="background:var(--blue)"></span>actual daily cost</span>
      <span><span class="swatch" style="background:var(--yellow);border-top:1px dashed var(--yellow)"></span>$0.83/day = $25/mo budget</span>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Quick facts — verbatim stack.lastHealthRunSummary
// ═══════════════════════════════════════════════════════════════════════════
function renderQuickFacts(s) {
  const text = s.stack?.lastHealthRunSummary || '(no health summary yet)';
  $('quick-facts').innerHTML = `
    <h2 class="panel-title">Quick facts — current state</h2>
    <pre class="quick-facts">${esc(text)}</pre>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main render dispatcher
// ═══════════════════════════════════════════════════════════════════════════
function render(snap, status, stale) {
  lastSnap = snap;
  const sb = $('status-bar');
  sb.textContent = `${status} • last collector ${ageS(snap.generatedAt)}s ago`;
  sb.className = stale ? 'stale' : (status === 'connected' || status === 'reconnected' ? 'connected' : 'connecting');

  try { renderHeader(snap); } catch (e) { console.error('header', e); }
  try { renderDisks(snap); } catch (e) { console.error('disks', e); }
  try { renderArr(snap); } catch (e) { console.error('arr', e); }
  try { renderContainers(snap); } catch (e) { console.error('containers', e); }
  try { renderSetupGaps(snap); } catch (e) { console.error('gaps', e); }
  try { renderRecentRuns(snap); } catch (e) { console.error('runs', e); }
  try { renderCostTrend(); } catch (e) { console.error('cost', e); }
  try { renderQuickFacts(snap); } catch (e) { console.error('qf', e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SSE connection with reconnect
// ═══════════════════════════════════════════════════════════════════════════
let attempt = 0;
function connect() {
  const es = new EventSource('/api/stormhaven/stream');
  es.addEventListener('state', ev => {
    try {
      const snap = JSON.parse(ev.data);
      render(snap, 'connected', false);
      attempt = 0;
    } catch (e) { console.error(e); }
  });
  es.addEventListener('stale', () => {
    if (lastSnap) render(lastSnap, 'stale', true);
  });
  es.addEventListener('heartbeat', () => {});
  es.onerror = () => {
    es.close();
    attempt += 1;
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
    $('status-bar').textContent = `disconnected — retrying in ${delay/1000}s`;
    $('status-bar').className = 'connecting';
    setTimeout(() => fetch('/api/stormhaven/state').then(r => r.ok ? r.json() : null).then(snap => snap && render(snap, 'reconnected', false)).catch(()=>{}).finally(connect), delay);
  };
}

// Initial load: fetch snapshot + cost history in parallel, then connect SSE
Promise.all([
  fetch('/api/stormhaven/state').then(r => r.ok ? r.json() : Promise.reject(r.status)),
  loadCostTrend(),
])
  .then(([snap]) => render(snap, 'connected', false))
  .catch(err => {
    document.body.innerHTML = `<h1>🛡 Stormhaven Mission Control</h1>
      <p style="color:var(--red)">Failed to load: ${esc(String(err))}</p>
      <p>Check that <code>~/.openclaw/stormhaven/state.json</code> exists.</p>`;
  })
  .finally(connect);
