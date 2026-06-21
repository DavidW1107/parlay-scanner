// Automated value scanner: scan both likely XIs, score every player×market×line leg with a
// conservative probability (Wilson lower bound), merge captured bet365 odds for edge/EV, and
// assemble parlays in risk tiers. This is the "don't make me read the grid" layer.
import { resolveFixture, likelyXI } from './fotmob.js';
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

export async function legsForFixture(homeName, awayName, lastN = 18) {
  const key = `${homeName}|${awayName}|${lastN}`.toLowerCase();
  if (memo.has(key)) return memo.get(key);

  const { home, away } = await resolveFixture(homeName, awayName);
  if (!home || !away) throw new Error('team not found — check spelling');
  const [hx, ax] = await Promise.all([likelyXI(home.id), likelyXI(away.id)]);
  const roster = [...hx.map((p) => ({ ...p, team: home.name })), ...ax.map((p) => ({ ...p, team: away.name }))];

  const legs = [];
  for (const pl of roster) {
    // ponytail: sequential — teammates share match payloads (cached after the first), so the
    // real cost is ~2 squads of matches, not 22×. Parallelise only if first-scan latency bites.
    let rec;
    try { rec = await playerRecords(pl.id, lastN); } catch { continue; }
    if (!rec.records.length) continue;
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
  const out = { fixture: `${home.name} v ${away.name}`, home: home.name, away: away.name, legs };
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
  player: l.player, team: l.team, market: l.market, line: l.line, kind: l.kind,
  p: l.p, sample: l.sample, l10: l.l10, odds: l.odds, edge: l.edge,
});
const slimParlay = (p) => ({
  size: p.legs.length, prob: p.prob, odds: p.odds, fairOdds: p.fairOdds, ev: p.ev,
  ret10: p.odds ? +(10 * p.odds).toFixed(2) : null,
  legs: p.legs.map(slimLeg),
});

// Top-level: legs (+optional odds) -> ranked legs + tiered parlays, all slimmed for JSON.
export function recommend(data, oddsRows) {
  const haveOdds = !!(oddsRows && oddsRows.length);
  const legs = haveOdds ? withOdds(data.legs, oddsRows) : data.legs.map((l) => ({ ...l }));
  const { parlays, poolSize } = buildParlays(legs, { haveOdds });

  const byProb = [...parlays].sort((a, b) => b.prob - a.prob);
  const tiers = {
    bankers: byProb.filter((p) => p.legs.length <= 3).slice(0, 6).map(slimParlay),
    // Value = SMALL (2-leg) +EV parlays with a realistic chance. Ranking by raw EV over all sizes
    // is degenerate — EV compounds multiplicatively, so it always picks 5-leg longshots that never
    // land (P≈0). The clean value is in the single legs above; this is the honest step up from them.
    value: haveOdds
      ? parlays.filter((p) => p.ev > 0 && p.legs.length === 2 && p.prob >= 0.1).sort((a, b) => b.ev - a.ev).slice(0, 8).map(slimParlay)
      : [],
    longshots: parlays.filter((p) => p.legs.length >= 4).sort((a, b) => (b.odds || b.fairOdds) - (a.odds || a.fairOdds)).slice(0, 6).map(slimParlay),
  };
  const topLegs = legs
    .filter((l) => l.sample >= 6 && (!haveOdds || l.odds > 1))
    .sort((a, b) => (haveOdds ? (b.edge ?? -9) - (a.edge ?? -9) : b.p - a.p))
    .slice(0, 25).map(slimLeg);

  return {
    fixture: data.fixture, home: data.home, away: data.away, haveOdds,
    topLegs, tiers,
    meta: {
      legsScored: data.legs.length, parlayPool: poolSize, parlaysBuilt: parlays.length,
      note: 'Conservative (Wilson-LB) probabilities on a small sample. Same-match legs are ' +
            'correlated, so combined odds/returns are optimistic. A ranking tool, not a guarantee — bet responsibly.',
    },
  };
}

// --- demo: real fixture, confidence-only — run `node src/scanner.js "Man City" "Arsenal"` ---
if (process.argv[1] === (await import('url')).fileURLToPath(import.meta.url)) {
  const [, , home = 'Man City', away = 'Arsenal'] = process.argv;
  const data = await legsForFixture(home, away, 18);
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
