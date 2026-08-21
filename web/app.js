'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// bet365 price → decimal. Accepts "1.83", "5/6" (fractional), "evens".
function toDecimal(s) {
  s = (s || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'evens' || s === 'evs') return 2;
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b + 1 : null; }
  const d = parseFloat(s);
  return d > 1 ? d : null;
}
const pct = (h) => (h && h.rate != null ? Math.round(h.rate * 100) + '%' : '—'); // hitRate window object
const pctv = (v) => (v != null ? Math.round(v * 100) + '%' : '—');               // bare probability 0..1

let LAST_N = '18';
let LAST = null;      // last value scan {home, away, n} — for the odds re-rank
let MATCH = null;     // picked fixture {matchId, home, away, homeId, awayId, utc} — use its lineup
let LAST_REC = null;  // last /api/recommend payload — feeds the XI editor
let CUSTOM_XI = null; // {home:[ids], away:[ids]} — user-adjusted starters, rides every re-rank
let USE_ODDS = false; // a capture has merged for this fixture — keep odds on re-ranks
const cards = {};     // playerId -> deep-dive card element (dedupe + jump)

const setStatus = (msg, err) => { $('status').innerHTML = err ? `<span class="err">${esc(msg)}</span>` : esc(msg); };

// ---------- modal ----------
function modal(html) {
  const back = document.createElement('div');
  back.className = 'backdrop';
  back.innerHTML = `<div class="modal">${html}<button class="mclose">✕ close</button></div>`;
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  back.querySelector('.mclose').addEventListener('click', () => back.remove());
  document.body.appendChild(back);
  return back;
}

// ---------- fixtures picker (📅) ----------
async function openFixtures() {
  setStatus('loading upcoming fixtures…');
  const today = new Date();
  const dates = [0, 1, 2].map((i) => new Date(today.getTime() + i * 864e5).toISOString().slice(0, 10));
  const all = [];
  for (const ds of dates) {
    try {
      const list = await (await fetch(`/api/fixtures?date=${ds}`)).json();
      if (Array.isArray(list)) for (const f of list) if (!f.finished) all.push({ ...f, date: ds });
    } catch { /* skip a bad day */ }
  }
  if (!all.length) return setStatus('no upcoming fixtures found in popular leagues', true);
  setStatus(`${all.length} upcoming fixtures — click one to scan`);
  all.sort((a, b) => (a.date + (a.utc || '')).localeCompare(b.date + (b.utc || '')));
  let html = '<h2 class="mhead">Upcoming fixtures — click to scan</h2>', last = '';
  for (const f of all) {
    if (f.date !== last) { last = f.date; html += `<div class="fx-date">${f.date}</div>`; }
    const ko = (f.utc || '').slice(11, 16) || '--:--';
    html += `<div class="fx" data-mi="${f.matchId}" data-h="${esc(f.home)}" data-a="${esc(f.away)}"
      data-hi="${f.homeId || ''}" data-ai="${f.awayId || ''}" data-utc="${esc(f.utc || '')}">
      <span class="mono fx-ko">${ko}</span> ${esc(f.home)} <span class="muted">v</span> ${esc(f.away)}
      <span class="fx-lg">${esc(f.league || '')}</span></div>`;
  }
  const back = modal(html);
  back.querySelectorAll('.fx').forEach((el) => el.addEventListener('click', () => {
    MATCH = { matchId: +el.dataset.mi, home: el.dataset.h, away: el.dataset.a,
      homeId: +el.dataset.hi || null, awayId: +el.dataset.ai || null, utc: el.dataset.utc || null };
    $('home').value = el.dataset.h;
    $('away').value = el.dataset.a;
    back.remove();
    findValue();
  }));
}

// ---------- automated recommendations (★ Find value) ----------
function recommend({ useOdds = false, fresh = false } = {}) {
  const { home, away, n } = LAST;
  let u = `/api/recommend?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&lastN=${encodeURIComponent(n)}`;
  if (MATCH && MATCH.matchId) {
    u += `&matchId=${MATCH.matchId}`;
    if (MATCH.homeId) u += `&homeId=${MATCH.homeId}`;
    if (MATCH.awayId) u += `&awayId=${MATCH.awayId}`;
    if (MATCH.utc) u += `&utc=${encodeURIComponent(MATCH.utc)}`;
  }
  if (CUSTOM_XI) u += `&homeXI=${CUSTOM_XI.home.join(',')}&awayXI=${CUSTOM_XI.away.join(',')}`;
  if (useOdds) u += '&useOdds=1';
  if (fresh) u += '&fresh=1';
  return fetch(u).then((r) => r.json().then((rec) => {
    if (!r.ok || rec.error) throw new Error(rec.error || 'failed');
    return rec;
  }));
}

async function findValue() {
  const home = $('home').value.trim(), away = $('away').value.trim();
  if (!home || !away) return;
  LAST = { home, away, n: $('lastN').value.trim() || '18' };
  LAST_N = LAST.n;
  CUSTOM_XI = null; USE_ODDS = false; // fresh scan → back to the real lineup, odds re-merge on capture
  const via = MATCH ? ' (predicted lineup)' : '';
  setStatus(`scanning ${home} vs ${away}${via} — every starter × market (first run 1–2 min)…`);
  $('reco').innerHTML = '<div class="muted mono sm">scanning…</div>';
  try {
    renderRecos(await recommend({ fresh: true }));
  } catch (e) {
    $('reco').innerHTML = '';
    setStatus(e.message, true);
  }
}

const legLabel = (l) => `${l.player} — ${l.kind === 'atleast' ? l.market : `${l.market} o${l.line}`}`;

function badgeFor(status) {
  return ({
    confirmed: ['✓ CONFIRMED LINEUP — these players are starting', 'pos'],
    predicted: ['◑ PREDICTED XI — not confirmed yet; re-run Find value near kickoff', 'gold'],
    standard: ['◑ FotMob XI — likely starters; re-run Find value near kickoff to confirm', 'gold'],
    heuristic: ['⚠ ESTIMATED from recent starters — no lineup released, players may not start', 'neg'],
    custom: ['✎ YOUR XI — legs reflect your adjusted starters (★ Find value resets to the real lineup)', 'gold'],
  })[status] || ['◑ FotMob XI — likely starters; re-run near kickoff to confirm', 'gold'];
}

// drill-down data attributes (only player legs are clickable — team legs have no playerId)
const drillAttrs = (l) => l.playerId
  ? `data-pid="${l.playerId}" data-mk="${esc(l.marketKey || '')}" data-line="${l.line == null ? '' : l.line}"
     data-mkt="${esc(l.market)}" data-kind="${l.kind}" data-player="${esc(l.player)}"`
  : '';

function legRow(l, od) { // top-single-leg table row
  const ret = l.odds ? `€${(10 * l.odds).toFixed(0)}` : '';
  const ev = (od && l.edge != null) ? `${l.edge * 100 >= 0 ? '+' : ''}${(l.edge * 100).toFixed(1)}pp` : '';
  return `<tr class="legrow" ${drillAttrs(l)}>
    <td class="l">${esc(legLabel(l))} <span class="smp">n${l.sample}</span></td>
    <td class="mono">${pctv(l.season)}</td><td class="mono">${pctv(l.pRaw)}</td><td class="mono">${pctv(l.p)}</td>
    <td class="mono">${l.odds ? l.odds.toFixed(2) : '—'}</td><td class="mono">${ret}</td>
    <td class="mono ${od && l.edge > 0 ? 'pos' : od && l.edge < 0 ? 'neg' : ''}">${ev}</td></tr>`;
}

function parlaySummary(p) {
  return p.legs.map((l) => {
    const who = l.isTeam ? l.player : l.player.split(' ').pop();
    const mk = l.market.split(' ')[0];
    return `${who} ${mk}${l.kind === 'atleast' ? '' : ` o${l.line}`}`;
  }).join('  +  ');
}

function parlayCols(p) {
  const so = p.shownOdds;
  const odds = so != null ? (so < 100 ? so.toFixed(2) : so.toFixed(0)) + (p.capped ? ' cap' : '')
    : (p.fairOdds != null ? `${p.fairOdds.toFixed(1)} fair` : '—');
  const ret = p.ret10 ? `~€${p.ret10.toFixed(0)}` : '—';
  const ev = p.ev != null ? `${p.ev >= 0 ? '+' : ''}${p.ev.toFixed(2)}` : '';
  return `<span class="pp mono">${pctv(p.probRaw)} · ${pctv(p.probWilson)} · ${pctv(p.prob)}</span>
    <span class="po mono">${odds}</span><span class="pr mono">${ret}</span>
    <span class="mono ${(p.ev || 0) > 0 ? 'pos' : ''}">${ev}</span>`;
}

function legLine(l, od) { // a parlay's child leg
  const ret = l.odds ? `€${(10 * l.odds).toFixed(0)}` : '';
  const ev = (od && l.edge != null) ? `${l.edge * 100 >= 0 ? '+' : ''}${(l.edge * 100).toFixed(1)}pp` : '';
  return `<div class="leg" ${drillAttrs(l)}>
    <span class="lname">• ${esc(legLabel(l))}</span>
    <span class="lcols mono">${pctv(l.season)} · ${pctv(l.pRaw)} · ${pctv(l.p)}
      ${l.odds ? l.odds.toFixed(2) : ''} ${ret} <span class="${od && l.edge > 0 ? 'pos' : od && l.edge < 0 ? 'neg' : ''}">${ev}</span></span></div>`;
}

function parlayBlock(p, od) {
  const legs = p.legs.map((l) => legLine(l, od)).join('');
  const vars = (p.variants && p.variants.length)
    ? `<details class="variants"><summary>▸ ${p.variants.length} variation(s) — one leg swapped</summary>
        ${p.variants.map((v) => parlayBlock(v, od)).join('')}</details>`
    : '';
  return `<details class="parlay"><summary><span class="psum">${esc(parlaySummary(p))}</span>
    <span class="pcols">${parlayCols(p)}</span></summary><div class="plegs">${legs}${vars}</div></details>`;
}

function renderRecos(rec) {
  LAST_REC = rec;
  const od = rec.haveOdds;
  LAST_N = $('lastN').value.trim() || '18';
  const [btxt, bcls] = badgeFor(rec.lineupStatus || 'heuristic');
  let h = `<div class="badge ${bcls}">${esc(btxt)}
    <button id="btnXI" class="btn2 badge-btn">✎ Adjust starters</button></div>`;
  if (rec.rotationNote) h += `<div class="badge neg">⚠ ${esc(rec.rotationNote)}</div>`;
  if (rec.meta && rec.meta.oddsWarning) h += `<div class="badge neg">⚠ ODDS MISMATCH — ${esc(rec.meta.oddsWarning)}</div>`;

  h += `<div class="tier-head">Top single legs · by ${od ? 'edge' : 'confidence'}</div>`;
  h += `<table class="rtab"><thead><tr><th class="l">Selection</th><th>Raw</th><th>Wilson</th><th>Adj</th>
    <th>Odds</th><th>€10 →</th><th>EV</th></tr></thead><tbody>${rec.topLegs.map((l) => legRow(l, od)).join('')}</tbody></table>`;

  const order = od
    ? [['Value · best +EV (2–4 legs)', 'value'], ['Big return · 3–4 legs, biggest payout', 'bigReturn'],
       ['Longshot · 5–7 legs, maximum payout', 'longshot']]
    : [['Likely · most probable combos — Capture bet365 for edge', 'likely']];
  for (const [title, key] of order) {
    const fams = (rec.tiers && rec.tiers[key]) || [];
    h += `<div class="tier"><div class="tier-head">${esc(title)} <span class="muted">(${fams.length} distinct)</span></div>`;
    h += fams.map((f) => parlayBlock(f, od)).join('') || '<div class="muted mono sm">none</div>';
    h += `</div>`;
  }
  $('reco').innerHTML = h;
  const m = rec.meta || {};
  const tail = od ? 'odds merged ✓' : 'Capture bet365 to add odds + returns';
  setStatus(`${rec.fixture} — ${m.legsScored} legs scored, ${m.parlaysBuilt} parlays · ${tail}`);
}

// click any leg (single-row or parlay child) → its game log; the badge button → XI editor
$('reco').addEventListener('click', (e) => {
  if (e.target.id === 'btnXI') return openXIEditor();
  const t = e.target.closest('[data-pid]');
  if (!t) return;
  legDrill({ playerId: +t.dataset.pid, marketKey: t.dataset.mk,
    line: t.dataset.line === '' ? null : +t.dataset.line, market: t.dataset.mkt, kind: t.dataset.kind, player: t.dataset.player });
});

// ---------- XI editor — adjust who you think starts, legs re-rank around YOUR XI ----------
async function openXIEditor() {
  if (!LAST_REC || !LAST_REC.homeId || !LAST_REC.awayId) return setStatus('run ★ Find value first', true);
  setStatus('loading squads…');
  let sq;
  try {
    const r = await fetch(`/api/squads?homeId=${LAST_REC.homeId}&awayId=${LAST_REC.awayId}`);
    sq = await r.json();
    if (!r.ok || sq.error) throw new Error(sq.error || 'failed');
  } catch (e) { return setStatus(e.message, true); }
  setStatus('');

  const cur = CUSTOM_XI || { home: (LAST_REC.xi?.home || []).map((p) => p.id), away: (LAST_REC.xi?.away || []).map((p) => p.id) };
  const side = (label, team, squad, xiIds) => {
    // XI players missing from the squad list (loans/new signings) still need a pill
    const known = new Set(squad.map((p) => p.id));
    const extra = (team || []).filter((p) => !known.has(p.id)).map((p) => ({ ...p, position: 'Other' }));
    let html = `<div class="xi-side" data-side="${label}"><h2>${esc(label === 'home' ? LAST_REC.home : LAST_REC.away)}
      <span class="xi-cnt mono" data-cnt="${label}"></span></h2>`;
    let pos = '';
    for (const p of [...squad, ...extra]) {
      if (p.position !== pos) { pos = p.position; html += `<div class="pos">${esc(pos || 'Squad')}</div>`; }
      html += `<span class="player${xiIds.includes(p.id) ? ' xi' : ''}" data-xid="${p.id}">${esc(p.name)}</span>`;
    }
    return html + '</div>';
  };
  const back = modal(`<h2 class="mhead">Adjust starters — click players in/out (gold = starting)</h2>
    ${side('home', LAST_REC.xi?.home, sq.home, cur.home)}
    ${side('away', LAST_REC.xi?.away, sq.away, cur.away)}
    <button id="xiApply">✓ Re-rank with this XI</button>`);

  const count = () => back.querySelectorAll('.xi-side').forEach((s) => {
    const n = s.querySelectorAll('.player.xi').length;
    const el = s.querySelector('[data-cnt]');
    el.textContent = `${n}/11`;
    el.className = 'xi-cnt mono' + (n === 11 ? '' : ' err');
  });
  count();
  back.addEventListener('click', (e) => {
    const p = e.target.closest('[data-xid]');
    if (p) { p.classList.toggle('xi'); count(); }
  });
  back.querySelector('#xiApply').addEventListener('click', async () => {
    const pickIds = (lbl) => [...back.querySelectorAll(`[data-side="${lbl}"] .player.xi`)].map((p) => +p.dataset.xid);
    const home = pickIds('home'), away = pickIds('away');
    if (!home.length || !away.length) return setStatus('each team needs at least one starter', true);
    CUSTOM_XI = { home, away };
    back.remove();
    setStatus('re-ranking with your XI — new players fetch fresh stats (a few seconds each)…');
    $('reco').innerHTML = '<div class="muted mono sm">re-ranking…</div>';
    try { renderRecos(await recommend({ useOdds: USE_ODDS })); }
    catch (e) { $('reco').innerHTML = ''; setStatus(e.message, true); }
  });
}

// ---------- leg drill-down (/api/legstat) ----------
async function legDrill(l) {
  if (!l.playerId) return setStatus(`${l.player} — ${l.market}: team market (per-game view lands with team odds)`, false);
  setStatus(`loading ${l.player} — ${l.market} stats…`);
  try {
    const u = `/api/legstat?id=${l.playerId}&market=${encodeURIComponent(l.marketKey || '')}` +
      `&line=${l.line == null ? '' : l.line}&lastN=${encodeURIComponent($('lastN').value.trim() || '18')}`;
    const r = await fetch(u), d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'failed');
    renderLegStat(d);
    setStatus('');
  } catch (e) { setStatus(e.message, true); }
}

const winPct = (x) => (!x || x.rate == null) ? '—' : `${Math.round(x.rate * 100)}% (${x.hits}/${x.n})`;

function renderLegStat(d) {
  const lt = d.kind === 'atleast' ? '' : ` o${d.line}`, w = d.windows;
  const log = d.log.map((g) => `<tr class="${g.hit ? 'pos' : 'neg'}">
    <td class="l">${g.isHome ? '(H) ' : '(A) '}${esc(g.opp || '')}</td>
    <td class="mono">${g.value}</td><td class="mono">${g.minutes}</td><td class="mono">${g.hit ? '✓' : '·'}</td></tr>`).join('');
  modal(`<h2 class="mhead">${esc(d.player)} · ${esc(d.market)}${lt}</h2>
    <div class="lswin mono">
      <div>Hit rate (cleared the line):</div>
      <div>L10 &nbsp; ${winPct(w.last10)}</div><div>L5 &nbsp;&nbsp; ${winPct(w.last5)}</div>
      <div>Season ${winPct(w.season)}</div><div>&nbsp;</div>
      <div>Home ${winPct(w.home)}</div><div>Away ${winPct(w.away)}</div>
      <div class="pad">Per-90 average: ${d.per90 != null ? d.per90 : '—'}</div>
    </div>
    <div class="tier-head">Recent games</div>
    <table class="rtab"><thead><tr><th class="l">Opponent</th><th>Value</th><th>Min</th><th>Hit</th></tr></thead>
      <tbody>${log}</tbody></table>`);
}

// ---------- scan squads → pills → deep-dive card ----------
async function scanSquads() {
  const home = $('home').value.trim(), away = $('away').value.trim();
  if (!home || !away) return;
  setStatus(`resolving ${home} vs ${away} + likely XI…`);
  try {
    const r = await fetch(`/api/fixture?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'failed');
    renderSquad($('homeSquad'), d.home);
    renderSquad($('awaySquad'), d.away);
    setStatus(`${d.home.name} vs ${d.away.name} — click a player to load their hit-rate grid`);
  } catch (e) { setStatus(e.message, true); }
}

const pill = (p, xi) => `<span class="player${xi ? ' xi' : ''}" data-id="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}</span>`;

function renderSquad(el, team) {
  const xiIds = new Set(team.xi.map((p) => p.id));
  let html = `<h2>${esc(team.name)}</h2><div class="pos">Likely XI</div>`;
  for (const p of team.xi) html += pill(p, true);
  html += `<div class="pos">Bench / squad</div>`;
  for (const p of team.squad.filter((p) => !xiIds.has(p.id))) html += pill(p, false);
  el.innerHTML = html;
  el.querySelectorAll('.player').forEach((pl) =>
    pl.addEventListener('click', () => loadPlayer({ id: +pl.dataset.id, name: pl.dataset.name })));
}

async function loadPlayer(p) {
  if (cards[p.id]) { cards[p.id].scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<span class="muted">loading ${esc(p.name)}…</span>`;
  cards[p.id] = card;
  $('detail').appendChild(card);
  try {
    const r = await fetch(`/api/deepdive?id=${p.id}&lastN=${encodeURIComponent(LAST_N)}`);
    const dd = await r.json();
    if (!r.ok) throw new Error(dd.error || 'failed');
    renderCard(card, dd);
  } catch (e) {
    card.innerHTML = `<span class="err">${esc(p.name)}: ${esc(e.message)}</span>`;
  }
}

function renderCard(card, dd) {
  const cells = [];
  let rows = '';
  for (const key of Object.keys(dd.markets)) {
    const m = dd.markets[key];
    rows += `<tr class="mkt-head"><td class="l" colspan="11">${esc(m.label)}</td></tr>`;
    for (const ln of m.lines) {
      const i = cells.push({ hitRate: ln.hitRate }) - 1;
      const label = m.kind === 'atleast' ? 'Anytime' : `o ${ln.line}`;
      const c = (h) => `<td class="mono hr ${h && h.rate != null && h.rate < 0.5 ? 'lo' : ''}">${pct(h)}</td>`;
      rows += `<tr>
        <td class="l muted">${label}</td>
        <td class="mono hr">${pct(ln.hitRate.last10)}<span class="smp"> /${ln.hitRate.last10.n}</span></td>
        ${c(ln.hitRate.last5)}${c(ln.hitRate.season)}${c(ln.hitRate.home)}${c(ln.hitRate.away)}
        <td><input class="odds mono" data-i="${i}" placeholder="—" /></td>
        <td class="mono muted" id="${dd.id}-imp-${i}">—</td>
        <td class="mono edge" id="${dd.id}-edge-${i}">—</td>
        <td class="mono muted" id="${dd.id}-fair-${i}">—</td>
      </tr>`;
    }
  }
  card.innerHTML = `<h2>${esc(dd.player)}</h2><div class="sub">last ${dd.sample} games · hit-rate by window · type a bet365 price for edge</div>
    <table>
      <thead><tr><th class="l">Line</th><th>L10</th><th>L5</th><th>Season</th><th>Home</th><th>Away</th>
        <th>Odds</th><th>Impl</th><th>Edge</th><th>Fair</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  card.querySelector('tbody').addEventListener('input', (e) => {
    if (!e.target.classList.contains('odds')) return;
    const i = e.target.dataset.i, hr = cells[i].hitRate, odds = toDecimal(e.target.value);
    const base = hr.last10.rate ?? hr.season.rate;
    const imp = $(`${dd.id}-imp-${i}`), edge = $(`${dd.id}-edge-${i}`), fair = $(`${dd.id}-fair-${i}`);
    if (!odds || base == null) { imp.textContent = edge.textContent = fair.textContent = '—'; edge.className = 'mono edge'; return; }
    const e100 = (base - 1 / odds) * 100;
    imp.textContent = (100 / odds).toFixed(1) + '%';
    edge.textContent = (e100 >= 0 ? '+' : '') + e100.toFixed(1) + 'pp';
    edge.className = 'mono edge ' + (e100 >= 0 ? 'pos' : 'neg');
    fair.textContent = (1 / base).toFixed(2);
  });
}

// ---------- bet365 attended capture → re-rank with odds ----------
async function captureBet365() {
  if (!LAST) return setStatus('run ★ Find value first, then Capture', true);
  setStatus('opening your browser on bet365 — sign in, open the fixture Bet Builder, then click the gold CAPTURE ODDS button (up to 20 min)…');
  try {
    const data = await (await fetch('/api/capture', { method: 'POST' })).json();
    if (!data.ok) return setStatus(`bet365 capture: ${data.reason || 'failed'}`, true);
    setStatus(`bet365: captured ${data.rows.length} prices — re-ranking parlays with odds…`);
    USE_ODDS = true; // XI edits after this keep the merged odds
    renderRecos(await recommend({ useOdds: true }));
  } catch (e) { setStatus(e.message, true); }
}

// ---------- wiring ----------
$('btnFx').addEventListener('click', openFixtures);
$('btnVal').addEventListener('click', findValue);
$('btnScan').addEventListener('click', scanSquads);
$('btnCap').addEventListener('click', captureBet365);
['home', 'away', 'lastN'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') findValue(); }));
['home', 'away'].forEach((id) => $(id).addEventListener('input', () => { MATCH = null; CUSTOM_XI = null; })); // typing a team drops the picked fixture + edited XI
