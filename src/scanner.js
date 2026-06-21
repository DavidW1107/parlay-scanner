// Automated value scanner: scan both likely XIs, score every player×market×line leg with a
// conservative probability (Wilson lower bound), merge captured bet365 odds for edge/EV, and
// assemble parlays in risk tiers. This is the "don't make me read the grid" layer.
import { resolveFixture, likelyXI, getFixtureLineup } from './fotmob.js';
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

// spec: { matchId?, home, away, homeId?, awayId? }. With a matchId we use THAT match's lineup
// (predicted → confirmed) so the XI is the players actually starting; otherwise we fall back to the
// recent-starter heuristic. lineupStatus tells the UI how much to trust it.
export async function legsForFixture(spec, lastN = 18) {
  const key = `${spec.matchId || `${spec.home}|${spec.away}`}|${lastN}`.toLowerCase();
  if (!spec.fresh && memo.has(key)) return memo.get(key); // fresh=1 re-fetches (e.g. lineup just confirmed)

  let homeName = spec.home, awayName = spec.away, homeXI, awayXI, lineupStatus = 'heuristic';

  if (spec.matchId) {
    let lu = null;
    try { lu = await getFixtureLineup(spec.matchId); } catch { /* no lineup released / fetch failed */ }
    if (lu) { homeName = lu.homeName || homeName; awayName = lu.awayName || awayName; }
    if (lu?.home?.starters?.length && lu?.away?.starters?.length) {
      homeXI = lu.home.starters; awayXI = lu.away.starters; lineupStatus = lu.type || 'predicted';
    } else {                                   // no lineup released yet → recent-starter heuristic
      const hId = spec.homeId || lu?.homeId, aId = spec.awayId || lu?.awayId;
      if (hId && aId) [homeXI, awayXI] = await Promise.all([likelyXI(hId), likelyXI(aId)]);
    }
  }
  if (!homeXI || !awayXI) {                    // manual team-name entry, or fallback
    const { home, away } = await resolveFixture(homeName, awayName);
    if (!home || !away) throw new Error('team not found — check spelling');
    homeName = home.name; awayName = away.name;
    [homeXI, awayXI] = await Promise.all([likelyXI(home.id), likelyXI(away.id)]);
    lineupStatus = 'heuristic';
  }
  const roster = [...homeXI.map((p) => ({ ...p, team: homeName })), ...awayXI.map((p) => ({ ...p, team: awayName }))];

  const recs = await pool(roster, 5, async (pl) => {
    try { return { pl, rec: await playerRecords(pl.id, lastN) }; } catch { return null; }
  });

  const legs = [];
  for (const r of recs) {
    if (!r || !r.rec.records.length) continue;
    const { pl, rec } = r;
    for (const [mk, m] of Object.entries(MARKETS)) {
      for (const line of LINES[mk] || [0.5]) {
        const s = marketLine(rec.records, m, line).hitRate;
        if (!s.season.n) continue;
        legs.push({
          id: `${rec.name}|${mk}|${line}`,
          player: rec.name, playerId: pl.id, team: pl.team,
          marketKey: mk, market: m.label, line, kind: m.kind,
          sample: s.season.n, hits: s.season.hits, p: wilsonLower(s.season.hits, s.season.n),
          l10: s.last10.rate, l5: s.last5.rate, season: s.season.rate,
          odds: null, implied: null, edge: null,
        });
      }
    }
  }
  const out = { fixture: `${homeName} v ${awayName}`, home: homeName, away: awayName, lineupStatus, legs };
  memo.set(key, out);
  return out;
}

// Merge captured bet365 prices onto legs (fresh copies — never mutate the memo).
function withOdds(legs, oddsRows) {
  return legs.map((leg) => {
    const o = { ...leg };
    const hit = (oddsRows || []).find((r) =>
      r.marketKey === leg.marketKey && nameMatch(r.player, leg.player) &&
      (leg.kind === 'atleast' ? r.line == null : r.line != null && Math.abs(r.line - leg.line) < 0.01));
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
  const strong = legs.filter((l) => l.sample >= 6);
  const byProb = strong.filter((l) => l.p >= 0.55).sort((a, b) => b.p - a.p).slice(0, 10);
  const byEdge = haveOdds ? strong.filter((l) => l.odds > 1 && l.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 10) : [];
  const seen = new Set();
  const pool = [];
  for (const l of [...byProb, ...byEdge]) { if (seen.has(l.id)) continue; seen.add(l.id); pool.push(l); if (pool.length >= poolSize) break; }

  const out = [];
  for (let k = 2; k <= Math.min(maxSize, pool.length); k++) {
    for (const idx of kCombos(pool.length, k)) {
      const ls = idx.map((i) => pool[i]);
      if (new Set(ls.map((l) => l.player)).size !== ls.length) continue;     // ≤1 leg per player (correlation guard)
      if (haveOdds && !ls.every((l) => l.odds > 1)) continue;                 // priced parlays only, so returns/EV are real
      out.push(combineParlay(ls));
    }
  }
  return { parlays: out, poolSize: pool.length };
}

const slimLeg = (l) => ({
  player: l.player, playerId: l.playerId, team: l.team, market: l.market, line: l.line, kind: l.kind,
  p: l.p, sample: l.sample, l10: l.l10, odds: l.odds, edge: l.edge,
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
    .filter((l) => l.sample >= 6 && (!haveOdds || l.odds > 1))
    .sort((a, b) => (haveOdds ? (b.edge ?? -9) - (a.edge ?? -9) : b.p - a.p))
    .slice(0, 25).map(slimLeg);

  return {
    fixture: data.fixture, home: data.home, away: data.away, haveOdds,
    lineupStatus: data.lineupStatus,
    topLegs, tiers,
    meta: {
      legsScored: data.legs.length, parlayPool: poolSize, parlaysBuilt: parlays.length,
      oddsWarning: rawHaveOdds && !matched
        ? `captured odds are for other players (${[...new Set(oddsRows.map((r) => r.player))].slice(0, 3).join(', ')}…) — capture THIS match's Bet Builder`
        : null,
      note: 'SINGLES are the edge — exact bet365 odds. VALUE = best +EV 2–4 leg combos; BIG RETURN = 3–4 legs ' +
            'for a bigger payout. Same-match legs correlate, so a multi\'s real bet365 price + EV are LOWER than ' +
            'the independent product shown, and payout caps at 1000/1. Conservative (Wilson-LB) probabilities, ' +
            'small sample. Verify on bet365; bet responsibly.',
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
