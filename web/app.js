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
const pct = (h) => (h && h.rate != null ? Math.round(h.rate * 100) + '%' : '—');

let LAST_N = '10';
const cards = {}; // playerId -> card element (dedupe + jump)

async function scan() {
  const home = $('home').value.trim(), away = $('away').value.trim();
  LAST_N = $('lastN').value.trim() || '10';
  if (!home || !away) return;
  $('status').textContent = 'resolving teams + likely XI…';
  $('homeSquad').innerHTML = $('awaySquad').innerHTML = $('detail').innerHTML = '';
  Object.keys(cards).forEach((k) => delete cards[k]);
  try {
    const r = await fetch(`/api/fixture?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    renderSquad($('homeSquad'), d.home);
    renderSquad($('awaySquad'), d.away);
    const xi = [...d.home.xi, ...d.away.xi];
    let done = 0;
    const tick = () => { $('status').textContent = `${d.home.name} vs ${d.away.name} — scanning ${++done}/${xi.length} starters…`; };
    await pool(xi, 4, async (p) => { await loadPlayer(p); tick(); });
    $('status').textContent = `${d.home.name} vs ${d.away.name} — ${xi.length} starters scanned · click bench to add more`;
  } catch (e) {
    $('status').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
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

// run fn over items with at most `n` concurrent
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: n }, worker));
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
  card.innerHTML = `<h2>${esc(dd.player)}</h2><div class="sub">last ${dd.sample} games · hit-rate by window</div>
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

$('scan').addEventListener('click', scan);
['home', 'away', 'lastN'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); }));
