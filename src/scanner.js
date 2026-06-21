// Automated value scanner: scan both likely XIs, score every player×market×line leg with a
// conservative probability (Wilson lower bound), merge captured bet365 odds for edge/EV, and
// assemble parlays in risk tiers. This is the "don't make me read the grid" layer.
import { resolveFixture, likelyXI, getFixtureLineup, getTeam } from './fotmob.js';
import { playerRecords, LINES } from './scan.js';
import { MARKETS } from './markets.js';
import { marketLine, wilsonLower, combineParlay, impliedProb } from './engine.js';

// --- small ports of the UI helpers so odds/names match identically server-side ---
function toDecimal(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'evens' || s === 'evs') return 2;
  if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b + 1 : null; }
  const d = parseFloat(s);
  return d > 1 ? d : null;
}
const tokens = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
function nameMatch(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length || ta[ta.length - 1] !== tb[tb.length - 1]) return false;   // surnames differ
  if (ta.length >= 2 && tb.length >= 2 && ta[0][0] !== tb[0][0]) return false;             // first initials differ
  return true;
}
const tnorm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/\b(fc|afc|cf|sc|ac)\b/g, '').replace(/\s+/g, ' ').trim();
function teamNameMatch(a, b) { // bet365 team name vs FotMob team name (national teams exact; clubs loose)
  const x = tnorm(a), y = tnorm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// memo so a follow-up "with odds" call reuses the (expensive) FotMob scan instead of re-fetching.
const memo = new Map();

// Run fn over items with at most n concurrent. Matters for the cold first scan: a national-team
// fixture's ~22 players come from different clubs (no shared match cache), so sequential is slow.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// Opponent adjustment: a player/team's form is vs AVERAGE opposition — scale it for THIS matchup.
// Attacking props down-weight vs a strong defence (opponent concedes few); defensive props up-weight
// vs a strong attack. Uses each team's goals for/against per game. ponytail: heuristic multiplier on
// the probability, NOT a calibrated model — directionally right (fixes "weak team to score vs strong
// side"); upgrade to a proper opponent-rated model if it needs to be sharper.
const AVG_GOALS = 1.3; // ~typical goals per team per game, the baseline a factor of 1.0 maps to
const ATTACK = new Set(['goals', 'assists', 'shots', 'sot', 'chances']);
const DEFENSE = new Set(['tackles', 'fouls', 'fouled', 'saves']); // up vs a strong attack (more to do / more shots faced)
const avgOf = (form, k) => (form.length ? form.reduce((s, f) => s + f[k], 0) / form.length : null);
function oppFactor(marketKey, opp) {
  if (!opp || opp.ga == null) return 1;
  const c = (x) => Math.max(0.45, Math.min(1.7, x));
  if (ATTACK.has(marketKey) || marketKey === 'team_goals') return c(opp.ga / AVG_GOALS); // vs opponent's leakiness
  if (DEFENSE.has(marketKey)) return c((opp.gf ?? AVG_GOALS) / AVG_GOALS);                // vs opponent's attack
  return 1; // passes / saves / offsides / cards / result / dc — left raw
}
const clampP = (p) => Math.max(0.02, Math.min(0.97, p));

// spec: { matchId?, home, away, homeId?, awayId? }. With a matchId we use THAT match's lineup
// (predicted → confirmed) so the XI is the players actually starting; otherwise we fall back to the
// recent-starter heuristic. lineupStatus tells the UI how much to trust it.
export async function legsForFixture(spec, lastN = 18) {
  const key = `${spec.matchId || `${spec.home}|${spec.away}`}|${lastN}`.toLowerCase();
  if (!spec.fresh && memo.has(key)) return memo.get(key); // fresh=1 re-fetches (e.g. lineup just confirmed)

  let homeName = spec.home, awayName = spec.away, homeXI, awayXI, lineupStatus = 'heuristic';
  let hId = spec.homeId, aId = spec.awayId;

  if (spec.matchId) {
    let lu = null;
    try { lu = await getFixtureLineup(spec.matchId); } catch { /* no lineup released / fetch failed */ }
    if (lu) { homeName = lu.homeName || homeName; awayName = lu.awayName || awayName; hId = hId || lu.homeId; aId = aId || lu.awayId; }
    if (lu?.home?.starters?.length && lu?.away?.starters?.length) {
      homeXI = lu.home.starters; awayXI = lu.away.starters; lineupStatus = lu.type || 'predicted';
    } else if (hId && aId) {                   // no lineup released yet → recent-starter heuristic
      [homeXI, awayXI] = await Promise.all([likelyXI(hId), likelyXI(aId)]);
    }
  }
  if (!homeXI || !awayXI) {                    // manual team-name entry, or fallback
    const { home, away } = await resolveFixture(homeName, awayName);
    if (!home || !away) throw new Error('team not found — check spelling');
    homeName = home.name; awayName = away.name; hId = home.id; aId = away.id;
    [homeXI, awayXI] = await Promise.all([likelyXI(home.id), likelyXI(away.id)]);
    lineupStatus = 'heuristic';
  }
  const roster = [...homeXI.map((p) => ({ ...p, team: homeName })), ...awayXI.map((p) => ({ ...p, team: awayName }))];

  // team form first — drives both the team markets AND the per-player opponent adjustment
  let homeForm = [], awayForm = [], homeDates = [], awayDates = [];
  if (hId && aId) {
    try {
      const [ht, at] = await Promise.all([getTeam(hId), getTeam(aId)]);
      homeForm = ht.form || []; awayForm = at.form || []; homeDates = ht.dates || []; awayDates = at.dates || [];
    } catch { /* form unavailable → no adjustment */ }
  }
  const homeOpp = { ga: avgOf(awayForm, 'ga'), gf: avgOf(awayForm, 'gf') }; // home XI faces the away team
  const awayOpp = { ga: avgOf(homeForm, 'ga'), gf: avgOf(homeForm, 'gf') };

  const recs = await pool(roster, 5, async (pl) => {
    try { return { pl, rec: await playerRecords(pl.id, lastN) }; } catch { return null; }
  });

  const legs = [];
  for (const r of recs) {
    if (!r || !r.rec.records.length) continue;
    const { pl, rec } = r;
    const opp = pl.team === homeName ? homeOpp : awayOpp;
    for (const [mk, m] of Object.entries(MARKETS)) {
      const factor = oppFactor(mk, opp);
      for (const line of LINES[mk] || [0.5]) {
        const s = marketLine(rec.records, m, line).hitRate;
        if (!s.season.n) continue;
        const pRaw = wilsonLower(s.season.hits, s.season.n);
        legs.push({
          id: `${rec.name}|${mk}|${line}`,
          player: rec.name, playerId: pl.id, team: pl.team,
          marketKey: mk, market: m.label, line, kind: m.kind,
          sample: s.season.n, hits: s.season.hits, pRaw, p: clampP(pRaw * factor),
          l10: s.last10.rate, l5: s.last5.rate, season: s.season.rate,
          odds: null, implied: null, edge: null,
        });
      }
    }
  }

  // team-level legs (result, total goals, BTTS, team goals) — opponent-adjusted where it applies
  legs.push(...teamLegs(homeName, homeForm, awayName, awayForm, homeOpp, awayOpp));

  // rotation context — only when the XI is OUR guess (heuristic). FotMob's predicted/confirmed XI
  // already encodes the tactical call (rest before a midweek game, rotate vs a weak side, etc.).
  let rotationNote = null;
  if (lineupStatus === 'heuristic') {
    const flags = [];
    const mUtc = spec.utc ? new Date(spec.utc).getTime() : NaN;
    const congested = (dates) => Number.isFinite(mUtc) && (dates || []).some((d) => {
      const dd = Math.abs(new Date(d).getTime() - mUtc); return dd > 36e5 && dd < 4 * 864e5; // another game within 4 days (not this one)
    });
    if (congested(homeDates)) flags.push(`${homeName} play again within 4 days`);
    if (congested(awayDates)) flags.push(`${awayName} play again within 4 days`);
    if (homeOpp.ga > 1.9) flags.push(`${homeName} heavy favourites`); // opponent leaks badly → likely rotation
    if (awayOpp.ga > 1.9) flags.push(`${awayName} heavy favourites`);
    if (flags.length) rotationNote = 'rotation risk — ' + flags.join('; ');
  }

  const out = { fixture: `${homeName} v ${awayName}`, home: homeName, away: awayName, lineupStatus, rotationNote, legs };
  memo.set(key, out);
  return out;
}

// Team markets from each side's recent results (no extra fetch — getTeam already has `form`).
// Per-match (Total Goals, BTTS) pool BOTH teams' matches; per-team (Result, Double Chance, Team
// Goals) use that team's own form. Result is opponent-naive — flagged so the UI can de-trust its edge.
function teamLegs(homeName, homeForm, awayName, awayForm, homeOpp, awayOpp) {
  const legs = [];
  const add = (selection, team, marketKey, market, line, kind, hits, n, naive = false, factor = 1) => {
    if (!n) return;
    const pRaw = wilsonLower(hits, n);
    legs.push({
      id: `${selection}|${marketKey}|${line}`, player: selection, playerId: null, team,
      marketKey, market, line, kind, isTeam: true, naive, corrKey: `${team}|${marketKey}`,
      sample: n, hits, pRaw, p: clampP(pRaw * factor), l10: hits / n, l5: null, season: hits / n,
      odds: null, implied: null, edge: null,
    });
  };
  for (const [name, form, opp] of [[homeName, homeForm, homeOpp], [awayName, awayForm, awayOpp]]) {
    const n = form.length;
    if (!n) continue;
    add(name, name, 'result', 'Match result', null, 'atleast', form.filter((f) => f.win).length, n, true);
    add(`${name} or draw`, name, 'dc', 'Double chance', null, 'atleast', form.filter((f) => f.win || f.draw).length, n, true);
    const tg = oppFactor('team_goals', opp); // down-weight scoring vs a strong defence
    for (const line of [0.5, 1.5, 2.5]) add(name, name, 'team_goals', 'Team goals', line, 'ou', form.filter((f) => f.gf > line).length, n, false, tg);
  }
  const both = [...homeForm, ...awayForm], N = both.length;
  if (N) {
    for (const line of [1.5, 2.5, 3.5]) add(`Over ${line}`, 'Match', 'ou_goals', 'Total goals', line, 'ou', both.filter((f) => f.total > line).length, N);
    add('Both teams score', 'Match', 'btts', 'BTTS', null, 'atleast', both.filter((f) => f.btts).length, N);
  }
  return legs;
}

// Merge captured bet365 prices onto legs (fresh copies — never mutate the memo).
function withOdds(legs, oddsRows) {
  return legs.map((leg) => {
    const o = { ...leg };
    const lineEq = (r) => r.line != null && Math.abs(r.line - leg.line) < 0.01;
    const hit = (oddsRows || []).find((r) => {
      if (r.marketKey !== leg.marketKey) return false;
      if (leg.isTeam) {                                        // team markets match by selection, not player name
        if (leg.marketKey === 'ou_goals') return lineEq(r);
        if (leg.marketKey === 'btts') return true;
        if (leg.marketKey === 'result' || leg.marketKey === 'dc') return teamNameMatch(r.player, leg.team);
        return false;                                          // team_goals — bet365 has no clean match here
      }
      return nameMatch(r.player, leg.player) && (leg.kind === 'atleast' ? r.line == null : lineEq(r));
    });
    const dec = hit && toDecimal(hit.odds);
    if (dec) { o.odds = dec; o.implied = impliedProb(dec); o.edge = o.p - o.implied; }
    return o;
  });
}

function* kCombos(n, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i <= n - (k - prefix.length); i++) yield* kCombos(n, k, i + 1, [...prefix, i]);
}

// Build parlays from a pool of the strongest legs (the full power set is astronomical and mostly
// noise). The pool is the UNION of the highest-probability legs (for Bankers) and — when odds are
// present — the highest-edge legs (for Value); these two sets barely overlap, since +edge legs are
// usually higher-odds / lower-prob. Without both, one tier or the other comes up empty.
function buildParlays(legs, { poolSize = 16, maxSize = 6, haveOdds = false } = {}) {
  const strong = legs.filter((l) => l.sample >= 6 && !l.naive); // naive (Result/DC): form can't price a matchup
  const byProb = strong.filter((l) => l.p >= 0.55).sort((a, b) => b.p - a.p).slice(0, 10);
  const byEdge = haveOdds ? strong.filter((l) => l.odds > 1 && l.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 10) : [];
  const seen = new Set();
  const pool = [];
  for (const l of [...byProb, ...byEdge]) { if (seen.has(l.id)) continue; seen.add(l.id); pool.push(l); if (pool.length >= poolSize) break; }

  const out = [];
  for (let k = 2; k <= Math.min(maxSize, pool.length); k++) {
    for (const idx of kCombos(pool.length, k)) {
      const ls = idx.map((i) => pool[i]);
      if (new Set(ls.map((l) => l.corrKey || l.player)).size !== ls.length) continue; // ≤1 leg per player / team-market
      if (haveOdds && !ls.every((l) => l.odds > 1)) continue;                 // priced parlays only, so returns/EV are real
      out.push(combineParlay(ls));
    }
  }
  return { parlays: out, poolSize: pool.length };
}

const slimLeg = (l) => ({
  player: l.player, playerId: l.playerId, team: l.team, marketKey: l.marketKey, market: l.market,
  line: l.line, kind: l.kind, isTeam: l.isTeam || false, naive: l.naive || false,
  p: l.p, pRaw: l.pRaw, sample: l.sample, l10: l.l10, odds: l.odds, edge: l.edge,
});
const PAYOUT_CAP = 1000; // bet365 Bet Builder caps payout at 1000/1 — display reflects it
const slimParlay = (p) => {
  const shownOdds = p.odds == null ? null : Math.min(p.odds, PAYOUT_CAP);
  return {
    size: p.legs.length, prob: p.prob, odds: p.odds, shownOdds, capped: p.odds != null && p.odds > PAYOUT_CAP,
    fairOdds: p.fairOdds, ev: p.ev,
    ret10: shownOdds ? +(10 * shownOdds).toFixed(2) : null,
    legs: p.legs.map(slimLeg),
  };
};

// Greedily keep the shown parlays distinct: cap how often any player-market is reused across the
// set (by player+market, not the exact line — else "Llorente Tackles o2.5/o3.5" count as different
// and one pick still dominates). Keeps the list from being ten near-identical multis.
const legKey = (l) => `${l.player}|${l.market}`;
function diversify(parlays, n, maxReuse = 2) {
  const used = new Map();
  const out = [];
  for (const p of parlays) {
    if (p.legs.some((l) => (used.get(legKey(l)) || 0) >= maxReuse)) continue;
    p.legs.forEach((l) => used.set(legKey(l), (used.get(legKey(l)) || 0) + 1));
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

// Top-level: legs (+optional odds) -> ranked legs + tiered parlays, all slimmed for JSON.
export function recommend(data, oddsRows) {
  const rawHaveOdds = !!(oddsRows && oddsRows.length);
  const legs = rawHaveOdds ? withOdds(data.legs, oddsRows) : data.legs.map((l) => ({ ...l }));
  const matched = legs.filter((l) => l.odds > 1).length;
  // Captured odds only "count" if they actually matched players in THIS fixture. A capture for a
  // different match merges nothing → fall back to confidence ranking and warn, don't show blanks.
  const haveOdds = rawHaveOdds && matched > 0;
  const { parlays, poolSize } = buildParlays(legs, { haveOdds });

  const byProb = [...parlays].sort((a, b) => b.prob - a.prob);
  // Headline is SINGLES (topLegs). With odds: VALUE = best +EV 2–4 leg combos (the edge); BIG RETURN
  // = 3–4 legs for a bigger (capped) payout, still built from +edge legs. Pre-odds: LIKELY = highest
  // win-prob small combos as a placeholder until you capture.
  const tiers = haveOdds ? {
    value: diversify(parlays.filter((p) => p.ev > 0 && p.legs.length >= 2 && p.legs.length <= 4 && p.prob >= 0.08)
      .sort((a, b) => b.ev - a.ev), 8).map(slimParlay),
    bigReturn: diversify(parlays.filter((p) => p.legs.length >= 3 && p.legs.length <= 4 && p.prob >= 0.02)
      .sort((a, b) => (Math.min(b.odds || 0, PAYOUT_CAP) - Math.min(a.odds || 0, PAYOUT_CAP)) || b.prob - a.prob), 6).map(slimParlay),
  } : {
    likely: diversify(byProb.filter((p) => p.legs.length >= 2 && p.legs.length <= 3), 6).map(slimParlay),
  };
  const topLegs = legs
    .filter((l) => l.sample >= 6 && !l.naive && (!haveOdds || l.odds > 1)) // exclude Result/DC (opponent-naive)
    .sort((a, b) => (haveOdds ? (b.edge ?? -9) - (a.edge ?? -9) : b.p - a.p))
    .slice(0, 25).map(slimLeg);

  return {
    fixture: data.fixture, home: data.home, away: data.away, haveOdds,
    lineupStatus: data.lineupStatus, rotationNote: data.rotationNote,
    topLegs, tiers,
    meta: {
      legsScored: data.legs.length, parlayPool: poolSize, parlaysBuilt: parlays.length,
      oddsWarning: rawHaveOdds && !matched
        ? `captured odds are for other players (${[...new Set(oddsRows.map((r) => r.player))].slice(0, 3).join(', ')}…) — capture THIS match's Bet Builder`
        : null,
      note: 'Probabilities are OPPONENT-ADJUSTED — a weak team\'s attacking props are down-weighted vs a strong ' +
            'defence (and vice-versa). SINGLES are the edge (exact bet365 odds). VALUE = best +EV 2–4 leg combos; ' +
            'BIG RETURN = 3–4 legs for a bigger payout. Same-match legs correlate, so a multi\'s real bet365 price ' +
            '+ EV are LOWER than the independent product, payout caps at 1000/1. Conservative (Wilson-LB) on a small ' +
            'sample. Verify on bet365; bet responsibly.',
    },
  };
}

// --- demo: real fixture, confidence-only — run `node src/scanner.js "Man City" "Arsenal"` ---
if (process.argv[1] === (await import('url')).fileURLToPath(import.meta.url)) {
  const [, , home = 'Man City', away = 'Arsenal'] = process.argv;
  const data = await legsForFixture({ home, away }, 18);
  const rec = recommend(data, null);
  console.log(`\n${rec.fixture} — ${rec.meta.legsScored} legs scored, pool ${rec.meta.parlayPool}\n`);
  console.log('Top single legs by confidence:');
  for (const l of rec.topLegs.slice(0, 10)) {
    const lbl = l.kind === 'atleast' ? l.market : `${l.market} o${l.line}`;
    console.log(`  ${(Math.round(l.p * 100) + '%').padStart(4)}  ${l.player.padEnd(20)} ${lbl}  (n${l.sample})`);
  }
  console.log('\nTop "banker" parlays (most likely, ≤3 legs):');
  for (const p of rec.tiers.bankers.slice(0, 4)) {
    console.log(`  P(win) ${(p.prob * 100).toFixed(0)}%  fair ${p.fairOdds.toFixed(1)}  — ` +
      p.legs.map((l) => `${l.player.split(' ').pop()} ${l.kind === 'atleast' ? l.market.split(' ')[0] : l.market.split(' ')[0] + ' o' + l.line}`).join(' + '));
  }
  await (await import('./fotmob.js')).close();
}
