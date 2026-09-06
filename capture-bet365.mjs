// Attended, READ-ONLY bet365 odds capture — attaches to a REAL browser over CDP.
//
// bet365 blocks login on any browser Playwright *launches* (automation fingerprint), even with
// stealth flags. So we never launch Chromium: we attach over CDP to a genuine Edge/Chrome (just
// started with a debug port). bet365 sees a normal browser — login works exactly like a tab you
// opened yourself. You sign in, open a fixture's Bet Builder, and click the floating gold "CAPTURE
// ODDS" button; only then does it expand + scroll the grid to load every market and write
// _b365_capture.json.
//
// SAFETY: after YOU click the injected button, the script clicks only UI expanders ("Show more"
// and collapsed market-group headers) to render the grid — NEVER a price, a participant, or the
// betslip, so it cannot place a bet. It disconnects rather than closing your browser.
import { chromium } from 'playwright';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

const DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
const OUT = `${DIR}/_b365_capture.json`;
const CDP_PROFILE = `${DIR}/.b365cdp`;   // dedicated browser profile — log in here once, it persists
const PORT = 9333;                       // dedicated — the RSA test-watcher already owns 9222
const WAIT_MIN = 20; // generous: first-time bet365 login (2FA), navigate, find the markets, click
const BROWSERS = [   // first real browser binary that exists wins — Win / Linux / macOS
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const isOdds = (t) => /^(\d+\/\d+|\d+\.\d+|EVS|evens)$/i.test(t);

// --- market-mapper self-check: `node capture-bet365.mjs --selftest` (no browser, no network) ---
// toLeg is a hoisted function declaration, so it is callable here, before anything connects.
if (process.argv.includes('--selftest')) {
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
  const L = (group, colHeader, player) => toLeg({ group, colHeader, player, odds: '1.90', colIndex: 0 });
  // match totals: line in the row label, or in the column header with Over/Under rows
  assert(L('Total Corners', '', 'Over 9.5')?.marketKey === 'match_corners', 'total corners -> match_corners');
  assert(L('Total Corners', '', 'Over 9.5')?.line === 9.5, 'line read from the row label');
  assert(L('Match Corners', '10.5', 'Over')?.line === 10.5, 'line read from the column header');
  assert(L('Total Throw Ins', '', 'Over 40.5')?.marketKey === 'match_throws', 'throw-in total -> match_throws');
  // team totals: the side named in the title, or as the row label
  const tc = L('Liverpool Total Corners', '', 'Over 4.5');
  assert(tc?.marketKey === 'team_corners' && tc.line === 4.5, 'team corners keyed + lined');
  assert(tc.selection === 'Liverpool', `team carried for name matching, got ${tc?.selection}`);
  assert(L('Team Throw Ins', '18.5', 'Ipswich Town Over')?.selection === 'Ipswich Town', 'team read from the row label');
  // only the over side, and only push-free lines
  assert(L('Total Corners', '', 'Under 9.5') === null, 'under side not scored');
  assert(L('Total Corners', '10', 'Over') === null, 'bare whole-number line is a push market, skipped');
  assert(L('Total Corners', '10+', 'Over')?.line === 9.5, '"10+" is push-free, maps to over 9.5');
  // derivative corner markets must not be mistaken for a total
  for (const g of ['Most Corners', 'First Corner', 'Corner Handicap', 'Asian Corners', '1st Half Corners'])
    assert(L(g, '', 'Over 4.5') === null, `${g} is not a plain total`);
  // player markets still map as before
  assert(L('Shots on Target', '2+', 'Mohamed Salah')?.marketKey === 'sot', 'player SoT unaffected');
  assert(L('Match Result', 'Draw', 'Match')?.selection === 'Draw', 'draw column kept for the de-vig');
  console.log('OK, capture market mapping (corners + throw-ins, team + match, over-only, push-free).');
  process.exit(0);
}

rmSync(OUT, { force: true }); // clear stale capture so the app never reads an old run

const die = (reason) => { writeFileSync(OUT, JSON.stringify({ ok: false, reason, rows: [] })); process.exit(0); };

// Attach to a browser already listening on the debug port; if none, start a real one and wait.
async function connect() {
  try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { /* not up yet */ }
  const exe = BROWSERS.find(existsSync);
  if (!exe) die('no Edge or Chrome found to launch — install one or open it with --remote-debugging-port=9222');
  console.log('opening your browser with a debug port…');
  spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${CDP_PROFILE}`,
    '--no-first-run', '--no-default-browser-check', 'https://www.bet365.com'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) { await sleep(1000); try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { /* still starting */ } }
  die('could not attach to the browser on :9222');
}

const browser = await connect();
// Ensure a bet365 tab exists (covers reusing a browser whose bet365 tab was closed).
{
  const c0 = browser.contexts()[0] || (await browser.newContext());
  if (!c0.pages().some((p) => /bet365/.test(p.url()))) {
    const pg = await c0.newPage();
    await pg.goto('https://www.bet365.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
}
console.log(`CONNECTED — sign in (your real browser), open the fixture's Player Markets, then click the gold CAPTURE button (up to ${WAIT_MIN} min)…`);

// NO auto-detect (the homepage is full of odds + "Goalscorer/To Score" and false-fires instantly).
// SELF-HEALING button: this runs INSIDE the page and re-asserts the button every second from its
// own setInterval, so it survives bet365's React re-renders without depending on the Node loop.
// Idempotent (guarded by window.__capSetup) so re-injecting it is safe.
const BUTTON_FN = () => {
  if (window.__capSetup) return;
  window.__capSetup = true;
  const ensure = () => {
    if (document.getElementById('__capBtn')) return;
    const host = document.body || document.documentElement;
    if (!host) return;
    const b = document.createElement('button');
    b.id = '__capBtn';
    b.textContent = '📸 CAPTURE ODDS';
    Object.assign(b.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647', padding: '12px 18px',
      background: '#c9a24b', color: '#1a1408', border: '0', borderRadius: '8px',
      font: 'bold 14px system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 3px 12px rgba(0,0,0,.55)',
    });
    b.addEventListener('click', () => { window.__capture = true; b.textContent = '⏳ reading odds…'; b.style.background = '#56b06f'; });
    host.appendChild(b);
  };
  ensure();
  document.addEventListener('DOMContentLoaded', ensure);
  setInterval(ensure, 1000);
};

const allPages = () => browser.contexts().flatMap((c) => c.pages());
for (const c of browser.contexts()) await c.addInitScript(BUTTON_FN).catch(() => {}); // future navigations

// Clear any stale flag/button from a previous run so we always wait for a FRESH click.
for (const p of allPages()) {
  await p.evaluate(() => { window.__capture = false; window.__capSetup = false; document.getElementById('__capBtn')?.remove(); }).catch(() => {});
}

const deadline = Date.now() + WAIT_MIN * 60000;
let target = null, lastBeat = 0;
while (Date.now() < deadline && !target) {
  await sleep(1000);
  const pages = allPages();
  for (const p of pages) {
    await p.evaluate(BUTTON_FN).catch(() => {});                                    // inject into open tabs now
    if (await p.evaluate(() => !!window.__capture).catch(() => false)) { target = p; break; }
  }
  if (Date.now() - lastBeat > 5000) {  // heartbeat so the log shows which tabs we can see
    lastBeat = Date.now();
    console.log(`waiting… ${pages.length} tab(s): ${pages.map((p) => p.url().slice(8, 48)).join('  |  ') || '(none visible to CDP!)'}`);
  }
}
if (!target) {
  console.log('TIMEOUT — CAPTURE button never clicked.');
  writeFileSync(OUT, JSON.stringify({ ok: false, reason: 'capture button not clicked in time', rows: [] }));
  await browser.close();   // disconnects CDP; leaves your browser running
  process.exit(0);
}

// Read the WHOLE Bet Builder grid. bet365 collapses most market groups and caps each player list
// to ~6 behind a "Show more", and lazy-renders rows as they scroll into view — so one snapshot
// misses ~95% of it. We expand every group + every "Show more" (benign UI clicks — NEVER a price
// or the betslip), then scroll the page and accumulate every odds cell across scroll positions.
// Each gl-MarketGroup has a title (the market), a sticky player column (.bbl-…ParticipantLabel_Name),
// and odds columns (.gl-Market of .bbl-BetBuilderParticipant cells) row-aligned to the names.
// bet365 sometimes renders the whole app inside an IFRAME (route-dependent) — the top document is
// an empty shell and a main-frame read returns 0 cells. So the scrape runs in EVERY frame and the
// one that yields the most odds cells wins.
const SCRAPE = async () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const showMore = () => {
    for (const el of document.querySelectorAll('*'))
      if (el.children.length <= 1 && /^show more$/i.test(norm(el.textContent))) { try { el.click(); } catch {} }
  };
  showMore(); await sleep(500);
  for (const g of document.querySelectorAll('.gl-MarketGroupPod')) {            // expand collapsed groups
    if (g.querySelector('.bbl-BetBuilderParticipant_Odds')) continue;
    const btn = g.querySelector('[class*=MarketGroupButton],[class*=GroupHeader],[class*=CenteredLabel]');
    if (btn) { try { btn.click(); } catch {} await sleep(120); }
  }
  await sleep(400); showMore(); await sleep(500);

  const acc = new Map();   // keyed so re-reads across scroll positions de-dup
  const isOddsTxt = (t) => /^(\d+\/\d+|\d+\.\d+|EVS|evens)$/i.test(t);

  // 2026 markup: class names are build-hashed (brp-f2e5d7…) — only the layout suffix
  // "…Market-pwidthNN" survives, so read by STRUCTURE, not names. A market group = the parent of
  // 2+ pwidth columns; each column = 1 header cell + N row cells; the column whose rows are mostly
  // NON-odds text is the participant/name column, rows align 1:1 across columns (empty cell =
  // suspended, index keeps alignment). The legacy bbl- reader is kept below feeding the same
  // accumulator, so whichever markup the page has wins.
  const readNew = (tag = '') => {
    const cols = [...document.querySelectorAll('[class*=Market-pwidth]')];
    if (!cols.length) return;
    // classify every column: a NAMES column is mostly non-odds text, an ODDS column mostly prices
    const info = cols.map((c) => {
      const rows = [...c.children].map((k) => norm(k.innerText));
      const odds = rows.filter((t) => isOddsTxt(t)).length;
      const nonOdds = rows.filter((t) => t && !isOddsTxt(t)).length;
      return { c, rows, isName: nonOdds > odds, hasOdds: odds > 0 };
    });
    // odds columns cluster under one parent; the names column can live OUTSIDE that parent (the
    // player-prop grids scroll their odds columns horizontally with the names column sticky) — so
    // pair each cluster with the nearest-ancestor names column instead of assuming one parent.
    const clusters = new Map();
    for (const i of info) {
      if (i.isName || !i.hasOdds) continue;
      const k = i.c.parentElement;
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(i);
    }
    for (const [par, oddsCols] of clusters) {
      let nameCol = null, anchor = par;
      for (let a = par; a && a !== document.body && !nameCol; a = a.parentElement) {
        const cand = info.filter((i) => i.isName && a.contains(i.c));
        if (cand.length === 1 || (a === par && cand.length)) {
          nameCol = cand.sort((x, y) => y.rows.length - x.rows.length)[0];
          anchor = a;
        } else if (cand.length > 1) break;   // climbed into another section — bail rather than mispair
      }
      if (!nameCol) continue;
      // header row exists unless the first odds cell is already a price (Double Chance style)
      const hasHeader = !isOddsTxt(oddsCols[0].rows[0] || '');
      const body = (rows) => (hasHeader ? rows.slice(1) : rows);
      const names = body(nameCol.rows).map((t) => t.replace(/^\d+\s+/, '')); // strip shirt number
      if (!names.length) continue;
      // title: candidate texts above the anchor, preferring one with market words (a team-tab strip
      // like "Arsenal | Match" sits closer than the real "Shots on Target" header)
      const MARKETY = /shot|goal|assist|card|foul|tackl|pass|save|offside|result|both teams|double chance|score|corner|throw/i;
      let title = '', first = '';
      for (let a = anchor; a && !title && a !== document.body; a = a.parentElement)
        for (let s = a.previousElementSibling; s && !title; s = s.previousElementSibling) {
          const t = norm(s.innerText).split('\n')[0];
          if (!t || t.length > 48 || isOddsTxt(t)) continue;
          if (!first) first = t;
          if (MARKETY.test(t)) title = t;
        }
      title = (title || first).replace(/Sub On Play On.*$/i, '').replace(/Bet Boost.*$/i, '').trim();
      // tab-walk pass: suffix the active tab so different panes of one widget can't share keys
      // (toLeg matches by substring, so "Shots on Target Arsenal" still maps)
      if (tag && !title.toLowerCase().includes(tag.toLowerCase())) title = `${title} ${tag}`;
      oddsCols.forEach((i, ci) => {
        const colHeader = hasHeader ? i.rows[0] : '';
        body(i.rows).forEach((t, ri) => {
          const player = names[ri];
          if (!player || !isOddsTxt(t)) return;              // empty/suspended cell → skip, index holds
          acc.set(`${title}|${colHeader}|${ci}|${player}`, { group: title, colHeader, colIndex: ci, player, odds: t, suspended: false });
        });
      });
    }
  };
  // legacy bbl- Bet Builder markup — harmless no-op when the classes are gone
  const readLegacy = () => {
    const groups = [...document.querySelectorAll('.gl-MarketGroup')].filter((g) => g.querySelector('.bbl-BetBuilderParticipant_Odds'));
    const tops = groups.filter((g) => !groups.some((o) => o !== g && o.contains(g)));
    for (const g of tops) {
      const title = norm(g.querySelector('[class*=MarketGroupButton],[class*=GroupHeader],[class*=Subtitle]')?.textContent)
        .replace(/Sub On Play On.*$/i, '').replace(/Bet Boost.*$/i, '').trim();
      const names = [...g.querySelectorAll('.bbl-BetBuilderParticipantLabel_Name')].map((e) => norm(e.textContent));
      if (!names.length) continue;
      const cols = [...g.querySelectorAll('.gl-Market')].filter((m) => m.querySelector('.bbl-BetBuilderParticipant_Odds'));
      cols.forEach((m, colIndex) => {
        const hdrEl = m.querySelector('[class*=Header]') || m.querySelector('[class*=columnheader]');
        const colHeader = norm(hdrEl?.textContent);
        [...m.querySelectorAll('.bbl-BetBuilderParticipant')].forEach((c, ri) => {
          const player = names[ri];
          const odds = norm(c.querySelector('.bbl-BetBuilderParticipant_Odds')?.textContent);
          if (!player || !odds) return;
          acc.set(`${title}|${colHeader}|${colIndex}|${player}`, {
            group: title, colHeader, colIndex, player, odds,
            suspended: c.className.includes('Suspended') || !!c.querySelector('[class*=Suspended]'),
          });
        });
      });
    }
  };
  const read = (tag) => { readNew(tag); readLegacy(); };

  const se = document.scrollingElement;

  // Auto-expand collapsed sections (2026 markup): header = [role=button] with short title text,
  // section root = its parent, collapsed <=> the root's text is just the header's own (no body).
  // Guards: never an odds-pattern text, never a fixture row ("X v Y" would navigate), width >=280px
  // keeps us off price/selection cells. Repeat: expanding can lazy-render more sections.
  const expandAll = async () => {
    for (let round = 0; round < 3; round++) {
      let clicked = 0;
      for (const h of document.querySelectorAll('[role=button]')) {
        const t = norm(h.innerText);
        if (!t || t.length > 48 || isOddsTxt(t) || / v /i.test(t)) continue;
        const root = h.parentElement;
        if (!root || norm(root.innerText).length > t.length + 12) continue;  // body already populated
        if (root.querySelector('[class*=Market-pwidth]')) continue;          // already open
        if (h.getBoundingClientRect().width < 280) continue;                 // not a full-width section header
        try { h.click(); clicked++; } catch {}
        await sleep(80);
      }
      if (!clicked) break;
      await sleep(700);      // let the expanded grids render
    }
    showMore(); await sleep(500);
  };

  // Tabbed widgets render ONE pane at a time (team tabs "Arsenal | Match", market tabs
  // "Goalscorers | Multi Scorers | ...") so we click through every tab, reading after each, and
  // every pane lands in the accumulator. A strip = 2-6 short non-odds text cells in one row, inside
  // a section that shows odds columns. Rows read under a tab get the tab name suffixed to their
  // group so panes can't overwrite each other.
  // ponytail: a period tab ("1st Half") on a market we stat would mis-title its rows. None of the
  // player-prop widgets have period tabs today; revisit if bet365 adds them.
  // Strips are searched ONLY inside real market-section roots (a [role=button] header whose parent
  // holds odds columns), never page chrome, so a nav row ("Casino | Rewards") can't qualify. All
  // cells must share tag+class (real tabs are uniform) and contain no links (links navigate).
  const findStrips = () => {
    const roots = [];
    for (const h of document.querySelectorAll('[role=button]')) {
      const t = norm(h.innerText);
      if (!t || t.length > 48) continue;
      const root = h.parentElement;
      if (root && root.querySelector('[class*=Market-pwidth]') && !roots.includes(root)) roots.push(root);
    }
    const strips = [];
    for (const root of roots) {
      for (const e of root.querySelectorAll('div')) {
        const n = e.childElementCount;
        if (n < 2 || n > 6) continue;
        const kids = [...e.children];
        if (kids.some((k) => k.tagName !== kids[0].tagName || String(k.className) !== String(kids[0].className))) continue;
        if (kids.some((k) => k.tagName === 'A' || k.querySelector('a') || k.closest('a'))) continue;
        const texts = kids.map((k) => norm(k.innerText));
        if (!texts.every((t) => t && t.length <= 26 && !isOddsTxt(t) && !/ v /i.test(t))) continue;
        if (e.querySelector('[class*=Market-pwidth]')) continue;                  // a grid, not a strip
        const r = e.getBoundingClientRect();
        if (r.width < 120 || r.height > 90 || r.height < 14) continue;
        strips.push(kids);
      }
    }
    return strips;
  };

  // Everything we do to ONE market pane: expand it, read the default view, walk its tabs, then
  // scroll it (bet365 lazy-renders rows). Reused verbatim for each market group we visit.
  const sweepPane = async (tag = '') => {
    await expandAll();
    const strips = findStrips();
    read(tag);                                 // baseline: every widget's default pane
    let tabClicks = 0;
    for (const kids of strips) {
      if (tabClicks >= 40) break;              // runaway guard
      for (const k of kids) {
        const label = norm(k.innerText);
        try { k.scrollIntoView({ block: 'center' }); k.click(); } catch { continue; }
        tabClicks++;
        await sleep(380);                      // pane swap render
        read(tag ? `${tag} ${label}` : label);
      }
    }
    for (let y = 0; y <= se.scrollHeight + 600; y += 600) { se.scrollTop = y; await sleep(150); read(tag); }
    se.scrollTop = 0;
  };

  await sweepPane();                           // the pane the user opened (Player Markets)

  // Corners and throw-ins are NOT in the Player Markets pane. bet365 keeps them behind the
  // fixture's own market-group nav ("Main | Goals | Corners | Bookings | ..."), which swaps the
  // market list in place. Clicking one is the same class of UI click as a section expander: never a
  // price, a participant or the betslip. Anchors and anything inside one are excluded so a click
  // can't navigate off the fixture, and if the URL moves anyway we undo it and skip that item.
  const GROUPNAV = /^(corners?|throw[\s-]?ins?|corners?\s*&\s*cards|cards\s*&\s*corners?)$/i;
  // A nav item is a leaf label of the right size that is NOT a link (and not inside one), so a
  // click can never navigate off the fixture. Same predicate is used to find the labels and to
  // re-find each one at click time.
  const navCands = (test) => {
    const out = [];
    for (const el of document.querySelectorAll('div,span,button,li')) {
      if (el.children.length > 1) continue;                      // leaf-ish label only
      const t = norm(el.innerText);
      if (!t || !test(t)) continue;
      if (el.tagName === 'A' || el.closest('a')) continue;       // never navigate off the fixture
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.width > 400 || r.height < 14 || r.height > 80) continue;
      if (out.some((o) => o.el.contains(el) || el.contains(o.el))) continue;   // one node per label
      out.push({ el, t });
    }
    return out;
  };
  const navLabels = [...new Set(navCands((t) => GROUPNAV.test(t)).map((n) => n.t))].slice(0, 4);
  const startUrl = location.href;
  for (const label of navLabels) {
    // re-query every time: swapping a pane re-renders the nav, and a node captured before the first
    // click is detached by the second, where .click() silently does nothing
    const el = navCands((t) => t === label)[0]?.el;
    if (!el) continue;
    try { el.scrollIntoView({ block: 'center' }); el.click(); } catch { continue; }
    await sleep(1000);                                           // market list swap + first render
    if (location.href !== startUrl) { history.back(); await sleep(1500); continue; }
    await sweepPane(label);
  }

  return [...acc.values()];
};

let raw = [], scrapedFrames = 0;
for (const fr of target.frames()) {
  const cells = await fr.evaluate(SCRAPE).catch(() => []);
  scrapedFrames++;
  if (cells.length > raw.length) raw = cells;   // the frame holding the Bet Builder wins
}

// Map one raw cell → { marketKey, line } in our catalog, or null to skip. bet365 prices player
// over/unders as "N+" (≥N) which equals our over-(N−0.5) line; anytime markets name their column.
function toLeg(r) {
  if (!r.odds || !isOdds(r.odds) || r.suspended) return null;
  const g = r.group.toLowerCase(), h = r.colHeader.toLowerCase();
  const row = (r.player || '').toLowerCase();
  // --- TEAM markets: `selection` carries the bet (team name / 'Both teams score' / 'Over X') ---
  // full-match 1X2. The DRAW is captured too: it never becomes a leg (no team matches "Draw"), but
  // the scanner needs all three prices to de-vig the market into a real matchup strength, stripping
  // vig from home/away alone pushes the draw's share onto both and overstates the favourite.
  if (/\bresult\b/.test(g) && !/both teams|range|winning|half/.test(g)) {
    return row === 'match' ? { marketKey: 'result', line: null, selection: r.colHeader } : null;
  }
  // --- Corners / throw-ins, team totals and match totals --------------------------------------
  // Layout varies: the line can sit in the row label ("Over 9.5") or in the column header ("9.5"
  // with rows Over/Under), so take the number from wherever it appears. Only the OVER side is kept,
  // because every team stat line the scanner scores is an over.
  // ponytail: written against bet365's market NAMES, not verified against a live fixture's DOM
  // (that needs an attended signed-in run). Every capture writes _debug with the raw group/column
  // text, so a miss is diagnosable from one run instead of another DOM read.
  if (/corner|throw/.test(g)) {
    // plain totals only: handicaps, race-to, halves, "most corners" and exact counts aren't our lines
    if (/most|first|last|next|race|handicap|asian|exact|odd\/even|1st|2nd|half|minute|10 min/.test(g)) return null;
    const stat = /corner/.test(g) ? 'corners' : 'throws';
    const blob = `${row} ${h}`;
    if (!/over/.test(blob)) return null;                        // unders and exact counts aren't scored
    const m = blob.match(/(\d+(?:\.\d+)?)\s*(\+)?/);
    if (!m) return null;
    const n = Number(m[1]);
    // "10+" means >=10, i.e. our over-9.5. A BARE whole number is a push market (exactly 10 refunds),
    // which the engine's > line predicate would price wrong, so it is skipped rather than guessed at.
    const line = n % 1 !== 0 ? n : (m[2] ? n - 0.5 : null);
    if (line == null) return null;
    // a team-scoped market names the side, either in the title ("Liverpool Total Corners") or as the
    // row label; strip the market words and whatever is left is the team for the scanner to match
    const residue = r.group.replace(/\bteam\b|total|match|game|corners?|throw[\s-]?ins?|over|under|\d+(\.\d+)?/gi, '')
      .replace(/[^\w' -]/g, ' ').replace(/\s+/g, ' ').trim();
    const rowName = /^(over|under)\b/.test(row) ? '' : r.player.replace(/\s*(over|under)\s*\d*(\.\d+)?/i, '').trim();
    const team = residue || rowName;
    return team
      ? { marketKey: stat === 'corners' ? 'team_corners' : 'team_throws', line, selection: team }
      : { marketKey: stat === 'corners' ? 'match_corners' : 'match_throws', line, selection: `Over ${line}` };
  }
  if (/both teams to score/.test(g) && !/card|receive/.test(g)) {
    return row === 'match' && h === 'yes' ? { marketKey: 'btts', line: null, selection: 'Both teams score' } : null;
  }
  if (/double chance/.test(g)) {
    const m = r.player.match(/^(.+?)\s+or\s+draw$|^draw\s+or\s+(.+)$/i);          // "France or Draw" → France
    return m ? { marketKey: 'dc', line: null, selection: (m[1] || m[2]).trim() } : null;
  }
  if (/^total goals/.test(g) && !/range/.test(g)) {                             // Over col, row "N Goals" → over (N+0.5)
    const m = h === 'over' && r.player.match(/(\d+)\s*goals?/i);
    return m ? { marketKey: 'ou_goals', line: +m[1] + 0.5, selection: `Over ${+m[1] + 0.5}` } : null;
  }
  if (/inside box|in the box|1st half|first half|2nd half|second half/.test(g)) return null; // variants we don't stat
  if (/score or assist/.test(g)) {
    if (h.startsWith('score') && !h.includes('assist')) return { marketKey: 'goals', line: null };
    if (h === 'assist') return { marketKey: 'assists', line: null };
    return null; // "Score or Assist" combined — no clean single-market mapping
  }
  if (/to score|goalscorer/.test(g)) return h === 'anytime' ? { marketKey: 'goals', line: null } : null; // skip First/Last
  if (/cards|booked/.test(g)) return /booked/.test(h) ? { marketKey: 'card', line: null } : null; // skip 1st Card/Sent Off
  const stat = (/headed/.test(g) && /target/.test(g)) ? 'headed_sot'
    : (/outside box/.test(g) && /target/.test(g)) ? 'shots_outside_box'
    : /shots on target/.test(g) ? 'sot' : /shots/.test(g) ? 'shots'
    : /fouls committed/.test(g) ? 'fouls' : /be fouled|fouled/.test(g) ? 'fouled'
    : /tackles/.test(g) ? 'tackles' : /passes/.test(g) ? 'passes' : /saves/.test(g) ? 'saves' : null;
  if (!stat) return null;
  const m = r.colHeader.match(/(\d+)\s*\+/);          // "2+" → ≥2 → over 1.5
  return { marketKey: stat, line: m ? +m[1] - 0.5 : r.colIndex + 0.5 }; // fallback: cols run 1+,2+,3+…
}

const rows = [];
const seen = new Set();
const byMarket = {};
for (const r of raw) {
  const leg = toLeg(r);
  if (!leg) continue;
  const player = leg.selection ?? r.player;   // team legs carry the selection; player legs the player name
  const k = `${player}|${leg.marketKey}|${leg.line}`;
  if (seen.has(k)) continue; // same market priced in two groups (e.g. Score == Anytime)
  seen.add(k);
  rows.push({ player, marketKey: leg.marketKey, line: leg.line, odds: r.odds, rawMarket: `${r.group} / ${r.colHeader}` });
  byMarket[leg.marketKey] = (byMarket[leg.marketKey] || 0) + 1;
}

let fixture = '';
for (const fr of target.frames()) {   // fixture header lives in whichever frame has the content
  const txt = await fr.evaluate(() => document.body?.innerText || '').catch(() => '');
  fixture = txt.split('\n').map((s) => s.trim()).filter(Boolean).find((s) => / v /.test(s)) || '';
  if (fixture) break;
}
const groupsSeen = [...new Set(raw.map((r) => r.group))];
// Corner/throw-in cells that were SEEN but mapped to nothing. The mapper is written against
// bet365's market names rather than a verified DOM, so this is the one field to read if those
// markets come back empty: it shows the exact group/column/row text the rules have to handle.
const cornerThrowMisses = raw
  .filter((r) => /corner|throw/i.test(r.group) && !toLeg(r))
  .slice(0, 25)
  .map((r) => `${r.group} | ${r.colHeader} | ${r.player} | ${r.odds}`);
writeFileSync(OUT, JSON.stringify({ ok: true, url: target.url(), fixture, rows, _debug: { groupsSeen, byMarket, rawCells: raw.length, scrapedFrames, cornerThrowMisses } }, null, 1));
console.log(`CAPTURED ${rows.length} prices for ${fixture} → ${JSON.stringify(byMarket)}`);
await browser.close();   // disconnects CDP; your browser stays open
