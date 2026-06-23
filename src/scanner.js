// Automated value scanner: scan both likely XIs, score every player×market×line leg with a
// conservative probability (Wilson lower bound), merge captured bet365 odds for edge/EV, and
// assemble parlays in risk tiers. This is the "don't make me read the grid" layer.
import { resolveFixture, likelyXI, getFixtureLineup, getTeam, teamChances } from './fotmob.js';
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

// --- Game-script-aware matchup adjustment -------------------------------------------------------
// A player's form is vs AVERAGE opposition; re-weight it for THIS matchup using BOTH goals AND
// shot/SoT data (chances). Fixes two things the goals-only proxy missed (the England-v-Ghana case):
//   • a heavy favourite gets PARKED against (low block) → ALL its attacking props tempered, not boosted
//     (goals-against says Ghana leak, but the packed box says otherwise);
//   • the mismatch collapses the favourite's defensive props (GK saves, CB tackles/fouls — nobody tests
//     them) and spikes the underdog's (keeper peppered, defence besieged).
// ponytail: heuristic multipliers tuned by feel, NOT a calibrated model — directionally right, bounded,
// and it degrades to goals-only when shot data is missing. Upgrade to a real xG/possession model if needed.
const AVG = { goals: 1.3, shots: 12, sot: 4.2 };  // ~per-team-per-game baselines a factor of 1.0 maps to
const GS = { temper: 0.38, passive: 0.42, siege: 0.32, poss: 0.22, chanceWeight: 0.6 }; // game-script knobs
const ATTACK = new Set(['goals', 'assists', 'shots', 'sot', 'chances']);
const DEFENSE = new Set(['tackles', 'fouls', 'fouled', 'saves']);
const avgOf = (form, k) => (form.length ? form.reduce((s, f) => s + f[k], 0) / form.length : null);
const clampF = (x) => Math.max(0.4, Math.min(1.8, x));
const blendCG = (chance, goals) => (chance == null ? goals : chance * GS.chanceWeight + goals * (1 - GS.chanceWeight));

// control ∈ [-1,1]: how much the player's team dominates THIS matchup (>0 dominant). Blends the two
// sides' goal difference AND shot-on-target difference (goals + chances), per the user's ask.
function controlOf(meForm, meCh, oppForm, oppCh) {
  const gd = (f) => (avgOf(f, 'gf') ?? AVG.goals) - (avgOf(f, 'ga') ?? AVG.goals);
  const sd = (c) => (c ? c.sotF - c.sotA : 0);
  return Math.tanh(0.35 * (gd(meForm) - gd(oppForm)) + 0.12 * (sd(meCh) - sd(oppCh)));
}

// opp = the OTHER team's leakiness (ga/sa/sotA) + output (gf/sf/sotF); control = the player team's.
function gameFactor(marketKey, opp, control = 0) {
  if (!opp) return 1;
  const r = (v, avg) => (v == null ? null : v / avg);
  if (ATTACK.has(marketKey) || marketKey === 'team_goals') {
    const chance = marketKey === 'shots' ? r(opp.sa, AVG.shots) : r(opp.sotA, AVG.sot); // volume vs quality
    let f = blendCG(chance, r(opp.ga, AVG.goals) ?? 1);
    f *= control > 0 ? (1 - GS.temper * control)    // parked against → temper the favourite's whole attack
                     : (1 + GS.passive * control);  // passive underdog attacks even less (control<0 → ×<1)
    return clampF(f);
  }
  if (DEFENSE.has(marketKey)) {
    const chance = marketKey === 'saves' ? r(opp.sotF, AVG.sot) : r(opp.sf, AVG.shots); // saves∝SoT faced; tkl/foul∝shots faced
    let f = blendCG(chance, r(opp.gf, AVG.goals) ?? 1);
    f *= (1 - GS.siege * control);  // dominant (control>0) → little to do; dominated (<0) → besieged, more
    return clampF(f);
  }
  if (marketKey === 'passes') return clampF(1 + GS.poss * control); // dominant side keeps the ball → more passes
  return 1; // cards / offsides / result / dc — left raw
}
const clampP = (p) => Math.max(0.02, Math.min(0.97, p));

// Resolve the matchId for an upcoming fixture between two teams from FotMob's schedule, so a typed
// matchup can use the match's PUBLISHED lineup (predicted/confirmed/standard) instead of the
// recent-starter guess. Soonest unplayed meeting wins.
async function findFixtureId(homeId, awayId) {
  const { fixtures } = await getTeam(homeId);
  const ids = new Set([Number(homeId), Number(awayId)]); // f.homeId/f.awayId are numbers — match on numbers
  const found = (fixtures || [])
    .filter((f) => !f.finished && f.homeId && f.awayId && f.homeId !== f.awayId && ids.has(Number(f.homeId)) && ids.has(Number(f.awayId)))
    .sort((a, b) => new Date(a.utc || 0) - new Date(b.utc || 0));
  return found[0]?.id || null;
}

// spec: { matchId?, home, away, homeId?, awayId? }. We always prefer the match's PUBLISHED lineup —
// if no matchId was passed (typed entry), we resolve the teams and look the fixture up ourselves, so
// the released XI is used either way. Only when no lineup exists yet do we fall back to the
// recent-starter heuristic. lineupStatus tells the UI how much to trust it.
export async function legsForFixture(spec, lastN = 18) {
  const key = `${spec.matchId || `${spec.home}|${spec.away}`}|${lastN}`.toLowerCase();
  if (!spec.fresh && memo.has(key)) return memo.get(key); // fresh=1 re-fetches (e.g. lineup just confirmed)

  let homeName = spec.home, awayName = spec.away, homeXI, awayXI, lineupStatus = 'heuristic';
  let hId = spec.homeId, aId = spec.awayId, matchId = spec.matchId;

  // need team ids for the form/opponent adjustment and to discover the fixture — resolve from names.
  if ((!hId || !aId) && homeName && awayName) {
    const { home, away } = await resolveFixture(homeName, awayName);
    if (!home || !away) throw new Error('team not found — check spelling');
    homeName = home.name; awayName = away.name; hId = home.id; aId = away.id;
  }
  hId = hId != null ? Number(hId) : hId; aId = aId != null ? Number(aId) : aId; // keep `=== lu.homeId` numeric
  // typed entry (no matchId) → find the actual fixture so we use its real released lineup
  if (!matchId && hId && aId) matchId = await findFixtureId(hId, aId).catch(() => null);

  if (matchId) {
    let lu = null;
    try { lu = await getFixtureLineup(matchId, spec.fresh); } catch { /* no lineup released / fetch failed */ }
    if (lu?.home?.starters?.length && lu?.away?.starters?.length) {
      // FotMob may list this matchup with either team as "home" — orient to our hId/aId.
      const flip = hId && lu.homeId && lu.homeId !== hId;
      const H = flip ? lu.away : lu.home, A = flip ? lu.home : lu.away;
      homeXI = H.starters; awayXI = A.starters;
      homeName = (flip ? lu.awayName : lu.homeName) || homeName;
      awayName = (flip ? lu.homeName : lu.awayName) || awayName;
      hId = hId || (flip ? lu.awayId : lu.homeId); aId = aId || (flip ? lu.homeId : lu.awayId);
      lineupStatus = lu.type || 'predicted';
    }
  }
  if (!homeXI || !awayXI) {                    // no lineup published yet → recent-starter heuristic
    if (!hId || !aId) throw new Error('team not found — check spelling');
    [homeXI, awayXI] = await Promise.all([likelyXI(hId), likelyXI(aId)]);
    lineupStatus = 'heuristic';
  }
  const roster = [...homeXI.map((p) => ({ ...p, team: homeName })), ...awayXI.map((p) => ({ ...p, team: awayName }))];

  // team form + CHANCE profiles first — drive both the team markets AND the per-player game-script adjustment
  let homeForm = [], awayForm = [], homeDates = [], awayDates = [], homeCh = null, awayCh = null;
  if (hId && aId) {
    try {
      const [ht, at, hc, ac] = await Promise.all([getTeam(hId), getTeam(aId), teamChances(hId), teamChances(aId)]);
      homeForm = ht.form || []; awayForm = at.form || []; homeDates = ht.dates || []; awayDates = at.dates || [];
      homeCh = hc; awayCh = ac;
    } catch { /* form/chances unavailable → adjustment degrades to neutral */ }
  }
  // opponent profile each side faces (goals form + shot/SoT chance profile) + each side's match control
  const profileOf = (form, ch) => ({ ga: avgOf(form, 'ga'), gf: avgOf(form, 'gf'), sa: ch?.sa, sotA: ch?.sotA, sf: ch?.sf, sotF: ch?.sotF });
  const homeOpp = profileOf(awayForm, awayCh); // home XI faces the away team
  const awayOpp = profileOf(homeForm, homeCh);
  const homeControl = controlOf(homeForm, homeCh, awayForm, awayCh);
  const awayControl = -homeControl;            // zero-sum by construction (edges negate)

  const recs = await pool(roster, 5, async (pl) => {
    try { return { pl, rec: await playerRecords(pl.id, lastN) }; } catch { return null; }
  });

  const legs = [];
  for (const r of recs) {
    if (!r || !r.rec.records.length) continue;
    const { pl, rec } = r;
    const isHomePlayer = pl.team === homeName;
    const opp = isHomePlayer ? homeOpp : awayOpp;
    const control = isHomePlayer ? homeControl : awayControl;
    for (const [mk, m] of Object.entries(MARKETS)) {
      const factor = gameFactor(mk, opp, control);
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

  // team-level legs (result, total goals, BTTS, team goals) — game-script-adjusted where it applies
  legs.push(...teamLegs(homeName, homeForm, awayName, awayForm, homeOpp, awayOpp, homeControl, awayControl));

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
function teamLegs(homeName, homeForm, awayName, awayForm, homeOpp, awayOpp, homeControl = 0, awayControl = 0) {
  const legs = [];
  const add = (selection, team, marketKey, market, line, kind, hits, n, naive = false, factor = 1) => {
    if (!n) return;
    const pRaw = wilsonLower(hits, n);
    legs.push({
      id: `${selection}|${marketKey}|${line}`, player: selection, playerId: null, team,
      // result + dc share a corrKey → a parlay won't stack a team's win AND its double-chance (redundant)
      marketKey, market, line, kind, isTeam: true, naive, corrKey: `${team}|${marketKey === 'dc' ? 'result' : marketKey}`,
      sample: n, hits, pRaw, p: clampP(pRaw * factor), l10: hits / n, l5: null, season: hits / n,
      odds: null, implied: null, edge: null,
    });
  };
  for (const [name, form, opp, control] of [[homeName, homeForm, homeOpp, homeControl], [awayName, awayForm, awayOpp, awayControl]]) {
    const n = form.length;
    if (!n) continue;
    add(name, name, 'result', 'Match result', null, 'atleast', form.filter((f) => f.win).length, n, true);
    add(`${name} or draw`, name, 'dc', 'Double chance', null, 'atleast', form.filter((f) => f.win || f.draw).length, n, true);
    const tg = gameFactor('team_goals', opp, control); // temper scoring vs a parked low block
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
    if (dec) {
      o.odds = dec; o.implied = impliedProb(dec); o.edge = o.p - o.implied;
      // naive team legs (Result/DC): form can't price a matchup — but the market just did. Adopt the
      // market-implied prob as the leg's prob (so the bogus form "edge" disappears) and it becomes a
      // sound priced booster: stacking the favourite's win in a game whose winner is all but known.
      // ponytail: raw 1/dec is one-way (includes vig); de-vig if a tighter parlay prob ever matters.
      if (o.isTeam && o.naive) { o.p = clampP(o.implied); o.edge = 0; }
    }
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
function buildParlays(legs, { poolSize = 20, maxSize = 6, haveOdds = false } = {}) {
  // naive (Result/DC): form can't price a matchup — excluded UNTIL the market prices it (l.odds set),
  // at which point its p is the market-implied prob. The p≥0.55 cut below then only keeps it for a
  // clear favourite, i.e. exactly the "winner all but known" game the user wants to stack.
  const strong = legs.filter((l) => l.sample >= 6 && (!l.naive || l.odds > 1));
  const byProb = strong.filter((l) => l.p >= 0.55).sort((a, b) => b.p - a.p).slice(0, 14);
  const byEdge = haveOdds ? strong.filter((l) => l.odds > 1 && l.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 14) : [];
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
  // three probabilities the UI shows side-by-side: raw observed hit-rate → Wilson-LB (sample-shrunk)
  // → game-script-adjusted for this fixture. season = raw, pRaw = Wilson, p = adjusted.
  season: l.season, p: l.p, pRaw: l.pRaw, sample: l.sample, l10: l.l10, odds: l.odds, edge: l.edge,
});
const PAYOUT_CAP = 1000; // bet365 Bet Builder caps payout at 1000/1 — display reflects it
const slimParlay = (p) => {
  const shownOdds = p.odds == null ? null : Math.min(p.odds, PAYOUT_CAP);
  const prod = (k) => p.legs.reduce((a, l) => a * (l[k] ?? l.p), 1); // combined prob at each stage
  return {
    size: p.legs.length, prob: p.prob, probRaw: prod('season'), probWilson: prod('pRaw'),
    odds: p.odds, shownOdds, capped: p.odds != null && p.odds > PAYOUT_CAP,
    fairOdds: p.fairOdds, ev: p.ev,
    ret10: shownOdds ? +(10 * shownOdds).toFixed(2) : null,
    legs: p.legs.map(slimLeg),
  };
};

// Group parlays into families so the headline list isn't ten near-identical multis. A parlay that
// differs from an already-shown "rep" by at most ONE leg is a *variation* of it (nested under it),
// not a new headline — so every top-level parlay differs from the others by ≥2 legs. Input must be
// pre-sorted best-first: the strongest member of each family becomes its rep, the rest are variants.
const legKey = (l) => `${l.player}|${l.market}`; // ignore the line — o2.5 vs o3.5 of one prop aren't "different"
function clusterParlays(parlays, { maxReps = 10, maxVariants = 6 } = {}) {
  const reps = [];
  for (const p of parlays) {
    const keys = new Set(p.legs.map(legKey));
    let host = null, bestShared = -1;
    for (const r of reps) {
      const shared = [...keys].filter((k) => r.keys.has(k)).length;
      // variation ⇔ differs from the rep by ≤1 leg (a swap, or one extra leg = an expansion)
      if (shared >= Math.max(keys.size, r.keys.size) - 1 && shared > bestShared) { host = r; bestShared = shared; }
    }
    if (host) { if (host.variants.length < maxVariants) host.variants.push(p); }
    else if (reps.length < maxReps) reps.push({ rep: p, keys, variants: [] });
  }
  return reps;
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
  // Each tier → families: a headline parlay (rep) with its one-leg-off variations nested under it.
  const clusterTier = (pool, maxReps) =>
    clusterParlays(pool, { maxReps, maxVariants: 6 })
      .map((c) => ({ ...slimParlay(c.rep), variants: c.variants.map(slimParlay) }));
  const tiers = haveOdds ? {
    value: clusterTier(parlays.filter((p) => p.ev > 0 && p.legs.length >= 2 && p.legs.length <= 4 && p.prob >= 0.08)
      .sort((a, b) => b.ev - a.ev), 12),
    bigReturn: clusterTier(parlays.filter((p) => p.legs.length >= 3 && p.legs.length <= 4 && p.prob >= 0.02)
      .sort((a, b) => (Math.min(b.odds || 0, PAYOUT_CAP) - Math.min(a.odds || 0, PAYOUT_CAP)) || b.prob - a.prob), 10),
  } : {
    likely: clusterTier(byProb.filter((p) => p.legs.length >= 2 && p.legs.length <= 3), 10),
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
      note: 'Probabilities are GAME-SCRIPT-ADJUSTED (goals + shots/SoT) — a heavy favourite parked against a low ' +
            'block has its WHOLE attack tempered (not boosted), its GK saves + defenders\' tackles/fouls collapse ' +
            '(nobody tests them), and the underdog\'s attack is suppressed while its keeper/defence get peppered. ' +
            'SINGLES are the edge (exact bet365 odds). VALUE = best +EV 2–4 leg combos; ' +
            'BIG RETURN = 3–4 legs for a bigger payout. Same-match legs correlate, so a multi\'s real bet365 price ' +
            '+ EV are LOWER than the independent product, payout caps at 1000/1. Conservative (Wilson-LB) on a small ' +
            'sample. Verify on bet365; bet responsibly.',
    },
  };
}

// --- demo: real fixture, confidence-only — run `node src/scanner.js "Man City" "Arsenal"` ---
if (process.argv[1] === (await import('url')).fileURLToPath(import.meta.url)) {
  // network-free check of the family clustering — `node src/scanner.js --selftest`
  if (process.argv.includes('--selftest')) {
    const P = (legs) => ({ prob: 0.5, ev: 0.1, odds: 5, fairOdds: 5, legs: legs.map((k) => ({ player: k, market: 'X', kind: 'atleast', line: null })) });
    const reps = clusterParlays([P(['A', 'B', 'C']), P(['A', 'B', 'D']), P(['A', 'B', 'C', 'E']), P(['D', 'E', 'F']), P(['A', 'C', 'D'])]);
    const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
    assert(reps.length === 2, `expected 2 families, got ${reps.length}`);                 // ABC… and DEF
    assert(reps[0].rep.legs.map((l) => l.player).join('') === 'ABC', 'first rep is the ABC mainline');
    assert(reps[0].variants.length === 3, `ABC family should nest 3 variations, got ${reps[0].variants.length}`); // ABD swap, ABCE expansion, ACD swap
    const k0 = new Set(reps[0].rep.legs.map((l) => l.player));
    assert(reps[1].rep.legs.filter((l) => k0.has(l.player)).length <= 1, 'headline reps must share ≤1 leg');

    // team Result leg: excluded while only form-priced, included once the market (bet365) prices it
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const team = { id: 'Eng|result', isTeam: true, naive: true, sample: 10, p: 0.95, corrKey: 'England|result', team: 'England', player: 'England', market: 'Match result', marketKey: 'result', kind: 'atleast', line: null, odds: null };
    const pl = [{ id: 'a', sample: 10, p: 0.7, odds: 1.6, player: 'A', market: 'Shots' }, { id: 'b', sample: 10, p: 0.65, odds: 1.8, player: 'B', market: 'Tackles' }];
    assert(!buildParlays([team, ...pl], { haveOdds: false }).parlays.some((p) => p.legs.some((l) => l.id === 'Eng|result')), 'naive team leg excluded pre-odds');
    const priced = withOdds([team], [{ marketKey: 'result', player: 'England', odds: '1.20', line: null }])[0];
    assert(near(priced.p, 1 / 1.20) && priced.edge === 0, 'priced naive team leg adopts market prob, 0 edge');
    assert(buildParlays([priced, ...pl], { haveOdds: true }).parlays.some((p) => p.legs.some((l) => l.id === 'Eng|result')), 'priced favourite-win leg now enters parlays');

    // game-script: heavy favourite (England, control +0.8) vs a weak, passive opponent (Ghana)
    const ghana = { ga: 1.6, gf: 0.8, sa: 14, sotA: 5, sf: 8, sotF: 2.5 };   // what England faces
    const eng = { ga: 0.7, gf: 2.2, sa: 7, sotA: 2, sf: 16, sotF: 6 };       // what Ghana faces
    assert(gameFactor('saves', ghana, 0.8) < 0.9, 'favourite GK saves collapse (opponent won\'t shoot)');
    assert(gameFactor('saves', eng, -0.8) > 1.2, 'underdog GK saves spike (peppered)');
    assert(gameFactor('fouls', ghana, 0.8) < 1.0, 'favourite defenders\' fouls down (no pressure)');
    assert(gameFactor('sot', eng, -0.8) < 0.8, 'passive underdog attack suppressed');
    assert(gameFactor('sot', ghana, 0.8) < gameFactor('sot', ghana, 0), 'low block tempers the favourite\'s attack vs no-dominance');
    assert(gameFactor('shots', ghana, 0.8) < gameFactor('shots', ghana, 0), 'temper-ALL: even shot volume is pulled down');
    assert(controlOf([{ gf: 2.2, ga: 0.7 }], null, [{ gf: 0.8, ga: 1.6 }], null) > 0.3, 'stronger side has clearly positive control');
    console.log('OK — clusterParlays + team Result priced-in + game-script (favourite attack tempered, saves/fouls collapse, underdog spikes).');
    process.exit(0);
  }
  const [, , home = 'Man City', away = 'Arsenal'] = process.argv;
  const data = await legsForFixture({ home, away }, 18);
  const rec = recommend(data, null);
  console.log(`\n${rec.fixture} — ${rec.meta.legsScored} legs scored, pool ${rec.meta.parlayPool}\n`);
  console.log('Top single legs by confidence:');
  for (const l of rec.topLegs.slice(0, 10)) {
    const lbl = l.kind === 'atleast' ? l.market : `${l.market} o${l.line}`;
    console.log(`  ${(Math.round(l.p * 100) + '%').padStart(4)}  ${l.player.padEnd(20)} ${lbl}  (n${l.sample})`);
  }
  console.log('\nTop "likely" parlay families (most probable, ≤3 legs — each with its variations nested):');
  for (const p of rec.tiers.likely.slice(0, 5)) {
    const summ = p.legs.map((l) => `${l.player.split(' ').pop()} ${l.kind === 'atleast' ? l.market.split(' ')[0] : l.market.split(' ')[0] + ' o' + l.line}`).join(' + ');
    console.log(`  P(win) ${(p.prob * 100).toFixed(0)}%  fair ${p.fairOdds.toFixed(1)}  — ${summ}` +
      (p.variants?.length ? `   (+${p.variants.length} variation${p.variants.length > 1 ? 's' : ''})` : ''));
  }
  await (await import('./fotmob.js')).close();
}
