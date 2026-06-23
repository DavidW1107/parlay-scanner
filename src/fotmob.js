// FotMob data layer — Playwright-driven (the site supplies its own x-mas token,
// so we read its embedded __NEXT_DATA__ instead of reverse-engineering endpoints).
// Browser launched once and reused; finished-match payloads cached to disk forever.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE_DIR, { recursive: true });
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _browser = null;
let _ctx = null;
let _ctxPromise = null;
let _dataPage = null;
async function ctx() {
  if (_ctx) return _ctx;
  // memoize the launch so concurrent first-callers (e.g. likelyXI(home)+likelyXI(away)) don't each
  // launch a browser — the loser would overwrite _browser and leak the first one.
  if (!_ctxPromise) _ctxPromise = (async () => {
    _browser = await chromium.launch({ headless: true });
    _ctx = await _browser.newContext({ userAgent: UA, locale: 'en-GB' });
    return _ctx;
  })();
  return _ctxPromise;
}
export async function close() {
  if (_browser) await _browser.close();
  _browser = _ctx = _ctxPromise = _dataPage = null;
}

// Call a FotMob JSON API from INSIDE a loaded fotmob page, so its own fetch wrapper adds the
// required token. A persistent page is kept warm for this. (api/data/matches needs the token;
// reading __NEXT_DATA__ doesn't cover the matches-by-date list.)
async function dataFetch(path) {
  if (!_dataPage || _dataPage.isClosed()) {
    _dataPage = await (await ctx()).newPage();
    await _dataPage.goto('https://www.fotmob.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await _dataPage.waitForTimeout(1500);
  }
  return _dataPage.evaluate(async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error('fotmob fetch ' + r.status);
    return r.json();
  }, path);
}

// disk cache: ttlMs=0 → never expires (finished matches are immutable).
// inflight map coalesces concurrent identical fetches (e.g. teammates sharing a match).
const inflight = new Map();
function cached(key, ttlMs, fn, keep = () => true, force = false) {
  const f = `${CACHE_DIR}${key.replace(/[^\w.-]/g, '_')}.json`;
  if (!force && existsSync(f)) {               // force: skip the read (still refetches + rewrites)
    const { ts, data } = JSON.parse(readFileSync(f, 'utf8'));
    if (ttlMs === 0 || Date.now() - ts < ttlMs) return data;
  }
  if (inflight.has(key)) return inflight.get(key);
  const pr = Promise.resolve(fn()).then(
    // keep(): don't persist empty/incomplete payloads (e.g. an upcoming match with no lineup
    // yet) under the forever-TTL, or it poisons the cache once the match is actually played.
    (data) => { if (keep(data)) writeFileSync(f, JSON.stringify({ ts: Date.now(), data })); inflight.delete(key); return data; },
    (e) => { inflight.delete(key); throw e; },
  );
  inflight.set(key, pr);
  return pr;
}

// Load a FotMob page and return props.pageProps from its embedded __NEXT_DATA__.
async function pageProps(url) {
  const page = await (await ctx()).newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const nd = await page.$eval('#__NEXT_DATA__', (e) => e.textContent).catch(() => null);
    if (!nd) throw new Error(`no __NEXT_DATA__ at ${url}`);
    return JSON.parse(nd).props.pageProps;
  } finally {
    await page.close();
  }
}

// --- Search (fast HTTP, no token needed) ---
export async function suggest(term) {
  const r = await fetch(
    `https://apigw.fotmob.com/searchapi/suggest?term=${encodeURIComponent(term)}&lang=en`,
    { headers: { 'User-Agent': UA } },
  );
  const j = await r.json();
  const parse = (arr) =>
    (arr?.[0]?.options ?? []).map((o) => {
      const [name, id] = o.text.split('|');
      // id LAST: o.payload carries a string `id` ("8491") that would otherwise clobber the number and
      // break every `=== teamId` comparison downstream (likelyXI, getTeam form) → wrong XI / swapped goals.
      return { name, ...o.payload, id: Number(id) };
    });
  return { players: parse(j.squadMemberSuggest), teams: parse(j.teamSuggest) };
}

// --- Player: recent matches + season stats ---
export function getPlayer(id) {
  return cached(`player-${id}`, 6 * 3600e3, async () => {
    const pp = await pageProps(`https://www.fotmob.com/players/${id}/x`);
    return pp.data; // {name, recentMatches[], mainLeague, statSeasons, ...}
  });
}

// --- Match: per-player stat lines for everyone in the match ---
// matchUrl comes from recentMatches[].matchPageUrl (carries the slug we can't derive from id alone).
export function getMatch(matchUrl) {
  const id = (matchUrl.match(/#(\d+)/) || [])[1] || matchUrl;
  return cached(`m4-${id}`, 0, async () => {
    const pp = await pageProps('https://www.fotmob.com' + (matchUrl.startsWith('/') ? matchUrl : '/' + matchUrl));
    const raw = pp.content?.playerStats || {};
    const players = {};
    for (const pid of Object.keys(raw)) {
      const e = raw[pid];
      players[pid] = { name: e.name, teamId: e.teamId, isGK: e.isGoalkeeper, stats: flatten(e.stats) };
    }
    // shot-level derived stats bet365 prices but playerStats omits: headed / outside-box on target
    for (const sh of pp.content?.shotmap?.shots || []) {
      const p = players[String(sh.playerId)];
      if (!p || !sh.isOnTarget) continue;
      if (/head/i.test(sh.shotType || '')) p.stats.headed_sot = (p.stats.headed_sot || 0) + 1;
      if (sh.isFromInsideBox === false) p.stats.shots_outside_box = (p.stats.shots_outside_box || 0) + 1;
    }
    const side = (t) => (t ? { id: t.id, formation: t.formation, starters: (t.starters || []).map((s) => ({ id: s.id, name: s.name, positionId: s.positionId })) } : null);
    const lu = pp.content?.lineup;
    return { matchId: id, players, lineup: lu ? { home: side(lu.homeTeam), away: side(lu.awayTeam) } : null };
    // only cache once the match has real data — never an upcoming match's empty shell
  }, (d) => Object.keys(d.players).length > 0 || d.lineup?.home?.starters?.length);
}

// Flatten FotMob's grouped stats into { canonicalKey: number }. Keyed by the stable
// inner `.key` AND the display title so STAT.resolve can match either.
function flatten(groups) {
  const out = {};
  for (const g of groups || [])
    for (const [title, obj] of Object.entries(g.stats || {})) {
      const v = obj?.stat?.value;
      if (typeof v === 'number') {
        out[title.toLowerCase()] = v;
        if (obj.key) out[obj.key.toLowerCase()] = v;
      }
    }
  return out;
}

// Canonical stat → list of possible FotMob titles/keys (first hit wins).
export const STAT = {
  aliases: {
    shots: ['total shots', 'shots'],
    sot: ['shots on target', 'shots_on_target', 'shotsontarget'],
    fouls: ['fouls committed', 'fouls', 'fouls_committed'],
    fouled: ['was fouled', 'was_fouled'],
    tackles: ['tackles won', 'tackles', 'tackles_won'],
    passes: ['accurate passes', 'passes', 'accurate_passes', 'total_passes'],
    chances: ['chances created', 'chances_created', 'chances_created_op'],
    saves: ['saves', 'saves_made'],
    offsides: ['offsides', 'offsides_caught'],
    headed_sot: ['headed_sot'],
    shots_outside_box: ['shots_outside_box'],
    rating: ['fotmob rating', 'rating_title'],
    minutes: ['minutes played', 'minutes_played'],
  },
  resolve(flat, canonical) {
    for (const a of this.aliases[canonical] || [canonical]) {
      const v = flat[a.toLowerCase()];
      if (typeof v === 'number') return v;
    }
    return undefined;
  },
};

// --- Team squad + fixture resolution ---
const findKey = (o, key, d = 0) => {
  if (!o || typeof o !== 'object' || d > 10) return null;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  for (const v of Object.values(o)) { const r = findKey(v, key, d + 1); if (r != null) return r; }
  return null;
};

export function getTeam(teamId) {
  teamId = Number(teamId); // ids cross HTTP/JSON as strings — keep the cache key + `=== teamId` numeric
  return cached(`team6-${teamId}`, 12 * 3600e3, async () => {
    const pp = await pageProps(`https://www.fotmob.com/teams/${teamId}/x`);
    const sq = findKey(pp, 'squad');
    const groups = Array.isArray(sq) ? sq : sq?.squad || [];
    const players = [];
    for (const g of groups) {
      if ((g.title || '').toLowerCase() === 'coach') continue;
      for (const m of g.members || g.players || []) if (m?.id) players.push({ id: m.id, name: m.name, position: g.title });
    }
    const all = findKey(pp, 'allFixtures')?.fixtures || [];
    const fin = all
      .filter((f) => f?.status?.finished && !f.status.cancelled)
      .sort((a, b) => new Date(b.status.utcTime) - new Date(a.status.utcTime)); // newest-first
    const finished = fin.filter((f) => f.pageUrl).map((f) => ({ id: f.id, pageUrl: f.pageUrl, utc: f.status.utcTime }));
    // team form (for team markets): goals/result/btts straight off each fixture's home/away score
    const form = fin
      .filter((f) => typeof f.home?.score === 'number' && typeof f.away?.score === 'number')
      .slice(0, 20)
      .map((f) => {
        const home = f.home.id === teamId;
        const gf = home ? f.home.score : f.away.score, ga = home ? f.away.score : f.home.score;
        return { gf, ga, total: f.home.score + f.away.score, btts: f.home.score > 0 && f.away.score > 0, win: gf > ga, draw: gf === ga, isHome: home };
      });
    const dates = all.filter((f) => f?.status?.utcTime).map((f) => f.status.utcTime); // for congestion checks
    // every fixture (incl. upcoming) so we can resolve a typed matchup → its matchId → published lineup
    const fixtures = all.map((f) => ({ id: f.id, pageUrl: f.pageUrl, homeId: f.home?.id, awayId: f.away?.id, utc: f?.status?.utcTime, finished: !!f?.status?.finished }));
    return { id: teamId, players, finished, form, dates, fixtures };
  });
}

// Recent CHANCE profile: shots & shots-on-target, for AND against, per game. Goals-based form is blind
// to a low block (few goals conceded ≠ few chances conceded); these aggregates are the signal that
// lets the matchup adjustment see "this side concedes/creates few real openings". Sums every player's
// shots per side from the cached match pages the scan already loads. Returns null if no shot data.
export async function teamChances(teamId, lookback = 6) {
  teamId = Number(teamId);
  return cached(`tc1-${teamId}-${lookback}`, 12 * 3600e3, async () => {
    const { finished } = await getTeam(teamId);
    let n = 0, sf = 0, sa = 0, sotF = 0, sotA = 0;
    for (const fx of finished) {
      if (n >= lookback) break;
      let md;
      try { md = await getMatch(fx.pageUrl); } catch { continue; }
      const players = Object.values(md.players || {});
      if (!players.some((p) => p.teamId === teamId)) continue; // our side must be present (with stats)
      let mS = 0, oS = 0, mT = 0, oT = 0, any = false;
      for (const p of players) {
        const sh = STAT.resolve(p.stats, 'shots'), st = STAT.resolve(p.stats, 'sot');
        if (sh == null && st == null) continue;
        any = true;
        if (p.teamId === teamId) { mS += sh || 0; mT += st || 0; } else { oS += sh || 0; oT += st || 0; }
      }
      if (!any) continue;
      sf += mS; sa += oS; sotF += mT; sotA += oT; n++;
    }
    return n ? { n, sf: sf / n, sa: sa / n, sotF: sotF / n, sotA: sotA / n } : null;
  });
}

// Most-frequent starters over the team's last `lookback` finished matches → likely XI.
export async function likelyXI(teamId, lookback = 6) {
  teamId = Number(teamId); // so `lu.home.id === teamId` matches (FotMob ids are numbers)
  const { players, finished } = await getTeam(teamId);
  const byId = new Map(players.map((p) => [p.id, p]));
  const starts = new Map();
  let scanned = 0;
  for (const fx of finished) {              // newest-first
    if (scanned >= lookback) break;
    let md;
    try { md = await getMatch(fx.pageUrl); } catch { continue; }
    const lu = md.lineup;
    const team = lu?.home?.id === teamId ? lu.home : lu?.away?.id === teamId ? lu.away : null;
    if (!team?.starters?.length) continue;  // skip upcoming / lineup-less matches
    scanned++;
    for (const s of team.starters) {
      const e = starts.get(s.id) || { id: s.id, name: s.name, count: 0 };
      e.count++; starts.set(s.id, e);
    }
  }
  const isGK = (p) => /keeper|goalkeep/i.test(p.position || '');
  const ranked = [...starts.values()].sort((a, b) => b.count - a.count)
    .map((r) => ({ id: r.id, name: r.name, position: byId.get(r.id)?.position || '' }));
  const xi = [];
  let gk = 0;
  for (const p of ranked) {                 // most-frequent first, but at most one keeper (rotation guard)
    if (isGK(p)) { if (gk) continue; gk++; }
    xi.push(p);
    if (xi.length === 11) break;
  }
  if (xi.length === 11) return xi;
  // fallback (too few lineups): pad from the squad — 1 keeper max, then outfielders
  const have = new Set(xi.map((p) => p.id));
  const pad = [...(gk ? [] : players.filter(isGK).slice(0, 1)), ...players.filter((p) => !isGK(p))].filter((p) => !have.has(p.id));
  return [...xi, ...pad].slice(0, 11);
}

// "Man City" + "Arsenal" → { home:{id,name}, away:{id,name} } via search
export async function resolveFixture(homeName, awayName) {
  const pick = async (q) => (await suggest(q)).teams[0] || null;
  const [home, away] = await Promise.all([pick(homeName), pick(awayName)]);
  return { home, away };
}

// --- Upcoming fixtures (for the picker) ---
// Popular domestic leagues + cups; internationals/World Cup come in via ccode === 'INT'.
const POPULAR = new Set([47, 87, 54, 55, 53, 42, 73, 48, 130, 50, 67, 9]);
export function listFixtures(dateStr) {
  const ymd = dateStr.replace(/-/g, '');
  return cached(`fixtures-${ymd}`, 20 * 60e3, async () => {
    const data = await dataFetch(`/api/data/matches?date=${ymd}&timezone=Europe/London`);
    const out = [];
    for (const L of data.leagues || []) {
      if (L.ccode !== 'INT' && !POPULAR.has(L.id)) continue;
      for (const m of L.matches || []) {
        out.push({
          matchId: m.id, home: m.home?.name, away: m.away?.name, homeId: m.home?.id, awayId: m.away?.id,
          league: L.name, utc: m.status?.utcTime, started: !!m.status?.started, finished: !!m.status?.finished,
        });
      }
    }
    return out;
  });
}

// --- A specific fixture's lineup, with status (predicted | confirmed | …) ---
// Short TTL on purpose: a "predicted" XI becomes "confirmed" ~1h before kickoff. Don't cache empty
// (no lineup released yet) so it re-fetches until one appears.
// fresh=true forces a live refetch (skips the 8-min cache) — a deliberate "Find value" near kickoff
// must reflect the latest XI, which can flip from FotMob's predicted to the confirmed lineup minutes
// before KO. Stats are immutable so they stay cached; only the lineup needs this.
export function getFixtureLineup(matchId, fresh = false) {
  return cached(`fxlu-${matchId}`, 8 * 60e3, async () => {
    const pp = await pageProps(`https://www.fotmob.com/match/${matchId}`);
    const lu = pp.content?.lineup;
    const g = pp.general || {};
    const side = (t) => (t ? { id: t.id ?? t.teamId, starters: (t.starters || []).map((s) => ({ id: s.id, name: s.name, positionId: s.positionId })) } : null);
    return {
      type: lu?.lineupType || null, // 'predicted' | 'confirmed' | 'standard' (finished)
      home: side(lu?.homeTeam), away: side(lu?.awayTeam),
      homeName: g.homeTeam?.name, awayName: g.awayTeam?.name,
      homeId: g.homeTeam?.id, awayId: g.awayTeam?.id,
    };
  }, (d) => (d.home?.starters?.length || d.away?.starters?.length) ? true : false, fresh);
}

// --- self-check: run `node src/fotmob.js` ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
  const s = await suggest('haaland');
  console.log('suggest:', s.players[0]);
  assert(s.players[0]?.id, 'suggest returns a player id');

  const p = await getPlayer(s.players[0].id);
  console.log('player:', p.name, '| recentMatches:', p.recentMatches.length);
  assert(p.recentMatches.length > 5, 'player has recent matches');

  const played = p.recentMatches.find((m) => m.homeScore != null && !m.onBench);
  const md = await getMatch(played.matchPageUrl);
  const me = md.players[p.id];
  console.log('match', md.matchId, '— available stat keys:\n ', Object.keys(me.stats).join(', '));
  console.log('resolved → shots:', STAT.resolve(me.stats, 'shots'),
    '| sot:', STAT.resolve(me.stats, 'sot'),
    '| fouls:', STAT.resolve(me.stats, 'fouls'),
    '| tackles:', STAT.resolve(me.stats, 'tackles'),
    '| passes:', STAT.resolve(me.stats, 'passes'),
    '| rating:', STAT.resolve(me.stats, 'rating'));
  assert(me.name, 'player found in match playerStats');
  await close();
  console.log('\nOK — fotmob data layer works.');
}
