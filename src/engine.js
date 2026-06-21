// Pure analytics — hit-rate, implied probability, vig strip, edge. No I/O, no deps.
import { fileURLToPath } from 'url';

export const impliedProb = (decimalOdds) => 1 / decimalOdds;

// Two-way vig strip: fair probability of each side once the bookmaker overround is removed.
export function stripVig(overOdds, underOdds) {
  const io = 1 / overOdds;
  const iu = 1 / underOdds;
  const sum = io + iu;
  return { over: io / sum, under: iu / sum, overround: sum - 1 };
}

// games newest-first. eligible() gates cameo appearances out of the denominator.
export function hitRate(games, predicate, eligible = () => true) {
  const elig = games.filter(eligible);
  const hits = elig.filter(predicate).length;
  return { n: elig.length, hits, rate: elig.length ? hits / elig.length : null };
}

// Build the over/anytime predicate for a market.
function predicate(market, line) {
  // ponytail: bet365 player lines are X.5 / anytime, so > line and >= n are push-free. Whole-number lines (pushes) not handled — add if a book offers them.
  if (market.kind === 'ou') return (g) => (g[market.stat] ?? 0) > line;
  return (g) => (g[market.stat] ?? 0) >= (market.n ?? 1);
}

// Hit-rate of one market at one line across all windows — NO odds needed (the deep-dive cell).
export function marketLine(games, market, line, opts = {}) {
  const minMinutes = opts.minMinutes ?? 60;
  const eligible = (g) => (g.minutes ?? 0) >= minMinutes;
  const pred = predicate(market, line);
  const windows = {
    season: games,
    last10: games.slice(0, 10),
    last5: games.slice(0, 5),
    home: games.filter((g) => g.isHome),
    away: games.filter((g) => !g.isHome),
  };
  const hr = {};
  for (const [k, gs] of Object.entries(windows)) hr[k] = hitRate(gs, pred, eligible);
  return { line, hitRate: hr, sample: hr.last10.n };
}

// edge from a hit-rate + offered odds (recent form drives it; UI shows all windows).
export function edgeOf(hitRate, odds, fairProb) {
  const implied = impliedProb(odds);
  const fair = fairProb ?? implied;
  const base = hitRate.last10.rate ?? hitRate.season.rate;
  return {
    impliedPct: +(implied * 100).toFixed(1),
    fairPct: +(fair * 100).toFixed(1),
    edge: base == null ? null : +((base - fair) * 100).toFixed(1), // percentage points
    fairOdds: base ? +(1 / base).toFixed(2) : null,
  };
}

// One player × one market × one offered line/price → full comparison row.
export function evalMarket(games, market, line, odds, opts = {}) {
  const ml = marketLine(games, market, line, opts);
  return { market: market.label, stat: market.stat, odds, ...ml, ...edgeOf(ml.hitRate, odds, opts.fairProb) };
}

// Wilson score interval, lower bound — a CONSERVATIVE estimate of the true hit probability
// given hits/n. z=1.2816 ≈ 90% one-sided. Small samples are pulled down hard, on purpose:
// 9/10 is not "90% likely", it's ~72% once you account for how little 10 games tells you.
// This is the scanner's confidence signal — it's what stops a hot streak masquerading as a lock.
export function wilsonLower(hits, n, z = 1.2816) {
  if (!n) return 0;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

// Combine legs into a parlay. INDEPENDENCE CAVEAT: legs from the same match are correlated
// (a team dominating lifts its players' shots, tackles, cards together), so the product is an
// OPTIMISTIC bound on the real joint probability — a ranking signal, never a guarantee.
// ev is per 1 unit staked; needs every leg priced (odds > 1) or it stays null.
export function combineParlay(legs) {
  const prob = legs.reduce((a, l) => a * l.p, 1);
  const priced = legs.every((l) => l.odds > 1);
  const odds = priced ? legs.reduce((a, l) => a * l.odds, 1) : null;
  return {
    legs,
    prob,
    odds,
    fairOdds: prob > 0 ? 1 / prob : null,
    ev: odds != null ? prob * (odds - 1) - (1 - prob) : null,
  };
}

// --- self-check: run `node src/engine.js` ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  // implied + vig
  assert(near(impliedProb(2.0), 0.5), 'implied 2.0 = 0.5');
  const v = stripVig(1.9, 1.9);
  assert(near(v.over, 0.5) && near(v.under, 0.5), 'symmetric vig strip = 0.5/0.5');
  assert(v.overround > 0.05 && v.overround < 0.06, 'overround ~5.3%');

  // synthetic shots log, newest-first, all 90 mins
  const shots = [3, 1, 2, 4, 0, 2, 5, 1, 2, 3];
  const games = shots.map((s) => ({ shots: s, minutes: 90, isHome: true }));
  const market = { label: 'Shots', stat: 'shots', kind: 'ou' };

  // over 1.5 → shots >= 2 → hits: 3,2,4,2,5,2,3 = 7/10 = 0.70
  const r = evalMarket(games, market, 1.5, 1.5); // odds 1.5 → implied 66.7%
  assert(r.sample === 10, 'sample 10');
  assert(near(r.hitRate.season.rate, 0.7), `season rate 0.70, got ${r.hitRate.season.rate}`);
  assert(r.edge === 3.3, `edge +3.3pp (70 - 66.7), got ${r.edge}`);
  assert(r.fairOdds === 1.43, `fair odds 1/0.7=1.43, got ${r.fairOdds}`);

  // cameo exclusion: a 20-min 0-shot game must not dilute the rate
  const g2 = [{ shots: 0, minutes: 20, isHome: true }, ...games];
  const r2 = evalMarket(g2, market, 1.5, 1.5);
  assert(r2.hitRate.season.n === 10, 'cameo (<60 min) excluded from denominator');

  // anytime market
  const goalsLog = [1, 0, 2, 0, 1].map((g) => ({ goals: g, minutes: 90, isHome: true }));
  const rg = evalMarket(goalsLog, { label: 'Anytime', stat: 'goals', kind: 'atleast', n: 1 }, 0, 2.5);
  assert(near(rg.hitRate.season.rate, 0.6), 'anytime scorer 3/5 = 0.60');

  // wilson lower bound: conservative, below raw rate, monotonic in n, bounded [0,1]
  assert(wilsonLower(0, 0) === 0, 'wilson n=0 -> 0');
  const w9 = wilsonLower(9, 10), w90 = wilsonLower(90, 100);
  assert(w9 < 0.9 && w9 > 0.6, `9/10 wilson ~0.72, got ${w9.toFixed(3)}`);
  assert(w90 > w9, 'more samples at same rate -> tighter (higher) lower bound');
  assert(wilsonLower(10, 10) < 1 && wilsonLower(10, 10) > 0.8, '10/10 wilson <1');

  // parlay combine: prob = product, odds = product, ev sign correct
  const p1 = combineParlay([{ p: 0.8, odds: 1.5 }, { p: 0.5, odds: 2.5 }]);
  assert(near(p1.prob, 0.4), `parlay prob 0.8*0.5=0.4, got ${p1.prob}`);
  assert(near(p1.odds, 3.75), `parlay odds 1.5*2.5=3.75, got ${p1.odds}`);
  assert(near(p1.ev, 0.4 * 2.75 - 0.6), 'parlay ev = prob*(odds-1)-(1-prob)');
  assert(p1.ev > 0, '0.4 win @ 3.75 is +EV');
  const unp = combineParlay([{ p: 0.8 }, { p: 0.5, odds: 2 }]);
  assert(unp.odds === null && unp.ev === null, 'unpriced leg -> no odds/ev');

  console.log('OK — engine math correct (hit-rate, vig strip, edge, cameo, anytime, wilson, parlay).');
}
