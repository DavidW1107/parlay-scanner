// Attended, READ-ONLY bet365 odds capture — attaches to a REAL browser over CDP.
//
// bet365 blocks login on any browser Playwright *launches* (automation fingerprint), even with
// stealth flags. So we never launch Chromium: we attach over CDP to a genuine Edge/Chrome (just
// started with a debug port). bet365 sees a normal browser — login works exactly like a tab you
// opened yourself. You sign in, open a fixture's Bet Builder / Player Markets, and click the
// floating gold "CAPTURE ODDS" button; only then does it read the whole painted grid in one pass
// and write _b365_capture.json.
//
// SAFETY: the script clicks NOTHING on bet365 — it only reads the painted grid after YOU click the
// injected button. It cannot place a bet, and it disconnects rather than closing your browser.
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
const BROWSERS = [   // a real browser binary — Edge is always present on Win11
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

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

// Read the WHOLE Bet Builder grid in one pass — every market group is already painted, so there
// is no tab-clicking. Each gl-MarketGroup has a title (the market), a sticky player-name column
// (.bbl-BetBuilderParticipantLabel_Name), and odds columns (.gl-Market) of .bbl-BetBuilderParticipant
// cells, row-aligned to the names. Returns raw cells; Node maps them to catalog markets/lines.
const raw = await target.evaluate(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const groups = [...document.querySelectorAll('.gl-MarketGroup')].filter((g) => g.querySelector('.bbl-BetBuilderParticipant_Odds'));
  const tops = groups.filter((g) => !groups.some((o) => o !== g && o.contains(g)));   // outermost only
  const out = [];
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
        out.push({
          group: title, colHeader, colIndex, player: names[ri],
          odds: norm(c.querySelector('.bbl-BetBuilderParticipant_Odds')?.textContent),
          suspended: c.className.includes('Suspended') || !!c.querySelector('[class*=Suspended]'),
        });
      });
    });
  }
  return out;
});

const isOdds = (t) => /^(\d+\/\d+|\d+\.\d+|EVS|evens)$/i.test(t);

// Map one raw cell → { marketKey, line } in our catalog, or null to skip. bet365 prices player
// over/unders as "N+" (≥N) which equals our over-(N−0.5) line; anytime markets name their column.
function toLeg(r) {
  if (!r.odds || !isOdds(r.odds) || r.suspended) return null;
  const g = r.group.toLowerCase(), h = r.colHeader.toLowerCase();
  if (/score or assist/.test(g)) {
    if (h.startsWith('score') && !h.includes('assist')) return { marketKey: 'goals', line: null };
    if (h === 'assist') return { marketKey: 'assists', line: null };
    return null; // "Score or Assist" combined — no clean single-market mapping
  }
  if (/to score/.test(g)) return h === 'anytime' ? { marketKey: 'goals', line: null } : null; // skip First/Last
  if (/cards|booked/.test(g)) return /booked/.test(h) ? { marketKey: 'card', line: null } : null; // skip 1st Card/Sent Off
  const stat = /shots on target/.test(g) ? 'sot' : /shots/.test(g) ? 'shots'
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
  const k = `${r.player}|${leg.marketKey}|${leg.line}`;
  if (seen.has(k)) continue; // same market priced in two groups (e.g. Score == Anytime)
  seen.add(k);
  rows.push({ player: r.player, marketKey: leg.marketKey, line: leg.line, odds: r.odds, rawMarket: `${r.group} / ${r.colHeader}` });
  byMarket[leg.marketKey] = (byMarket[leg.marketKey] || 0) + 1;
}

const fixture = (await target.innerText('body').catch(() => '')).split('\n').map((s) => s.trim())
  .filter(Boolean).find((s) => / v /.test(s)) || '';
const groupsSeen = [...new Set(raw.map((r) => r.group))];
writeFileSync(OUT, JSON.stringify({ ok: true, url: target.url(), fixture, rows, _debug: { groupsSeen, byMarket, rawCells: raw.length } }, null, 1));
console.log(`CAPTURED ${rows.length} prices for ${fixture} → ${JSON.stringify(byMarket)}`);
await browser.close();   // disconnects CDP; your browser stays open
