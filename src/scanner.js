// Automated value scanner: scan both likely XIs, score every player×market×line leg with a
// conservative probability (Wilson lower bound), merge captured bet365 odds for edge/EV, and
// assemble parlays in risk tiers. This is the "don't make me read the grid" layer.
import { resolveFixture, likelyXI, getFixtureLineup, getTeam, teamChances, teamMatchStats } from './fotmob.js';
import { playerRecords, LINES } from './scan.js';
import { MARKETS, TEAM_MARKETS } from './markets.js';
import { marketLine, wilsonLower, combineParlay, impliedProb, stripVigN } from './engine.js';

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
const ATTACK = new Set(['goals', 'assists', 'shots', 'sot', 'chances', 'team_shots', 'team_sot', 'team_corners', 'team_offsides']);
const DEFENSE = new Set(['tackles', 'fouls', 'fouled', 'saves', 'team_fouls', 'team_cards']);
const avgOf = (form, k) => (form.length ? form.reduce((s, f) => s + f[k], 0) / form.length : null);
const clampF = (x) => Math.max(0.4, Math.min(1.8, x));
const blendCG = (chance, goals) => (chance == null ? goals : chance * GS.chanceWeight + goals * (1 - GS.chanceWeight));

// Opponent strength multiplier per team id, from that opponent's own competitive goal difference.
// Raw form is blind to WHO you played: beating Wycombe and beating Man City look identical, which is
// exactly how a weak side ends up rated as the stronger team. w > 1 = a hard opponent.
const clampW = (w) => Math.max(0.6, Math.min(1.5, w));
async function opponentStrength(forms) {
  const ids = [...new Set(forms.flat().map((f) => f.oppId).filter(Boolean))];
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      const f = (await getTeam(id)).form || [];
      if (!f.length) return [id, 1];
      return [id, clampW(1 + 0.25 * (avgOf(f, 'gf') - avgOf(f, 'ga')))];  // gd +1.0 → ×1.25
    } catch { return [id, 1]; }   // an opponent we can't resolve is treated as average, never fatal
  }));
  return new Map(entries);
}

// Opponent-weighted goals for/against. Scoring against a strong side counts for more (×w); conceding
// to a weak side counts for more (÷w). Falls back to the plain average when no weights are known.
function weightedGoals(form, W) {
  if (!form.length) return null;
  let gf = 0, ga = 0;
  for (const f of form) {
    const w = W?.get(f.oppId) ?? 1;
    gf += f.gf * w; ga += f.ga / w;
  }
  return { gf: gf / form.length, ga: ga / form.length };
}

// control ∈ [-1,1]: how much the player's team dominates THIS matchup (>0 dominant). Blends the two
// sides' opponent-adjusted goal difference AND shot-on-target difference (goals + chances).
function controlOf(meForm, meCh, oppForm, oppCh, W) {
  const gd = (f) => { const g = weightedGoals(f, W); return g ? g.gf - g.ga : 0; };
  const sd = (c) => (c ? c.sotF - c.sotA : 0);
  return Math.tanh(0.35 * (gd(meForm) - gd(oppForm)) + 0.12 * (sd(meCh) - sd(oppCh)));
}

// The market is a far better judge of a matchup than a handful of results, so when the capture
// contains the 1X2 prices we use them instead of form: de-vig, then take (pHome - pAway) as control.
// Liverpool 1.20 / draw 7.0 / Ipswich 13.0 → +0.72, against the +0.17 form alone produced.
function controlFromOdds(oddsRows, homeName, awayName) {
  const sel = (r) => r.selection || r.player || '';
  const results = (oddsRows || []).filter((r) => r.marketKey === 'result');
  const priceFor = (team) => {
    const r = results.find((x) => teamNameMatch(sel(x), team));
    return r ? toDecimal(r.odds) : null;
  };
  const h = priceFor(homeName), a = priceFor(awayName);
  if (!h || !a) return null;
  const drawRow = results.find((x) => /^draw$/i.test(sel(x).trim()));
  const d = drawRow ? toDecimal(drawRow.odds) : null;
  // draw included whenever captured, a 1X2 de-vigged 2-way overstates both sides (see engine test)
  const { probs } = stripVigN(d ? [h, d, a] : [h, a]);
  return Math.max(-1, Math.min(1, probs[0] - probs[probs.length - 1]));
}

// opp = the OTHER team's leakiness (ga/sa/sotA) + output (gf/sf/sotF); control = the player team's.
function gameFactor(marketKey, opp, control = 0) {
  if (!opp) return 1;
  const r = (v, avg) => (v == null ? null : v / avg);
  if (ATTACK.has(marketKey) || marketKey === 'team_goals') {
    const chance = (marketKey === 'shots' || marketKey === 'team_shots') ? r(opp.sa, AVG.shots) : r(opp.sotA, AVG.sot); // volume vs quality
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
export async function findFixtureId(homeId, awayId) {
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
  // spec.homeXI / spec.awayXI: player-id arrays — the user's own starting XI (overrides any lineup)
  const custom = spec.homeXI?.length && spec.awayXI?.length;
  const cxi = custom ? `|cxi:${spec.homeXI.join('.')}~${spec.awayXI.join('.')}` : '';
  const key = `${spec.matchId || `${spec.home}|${spec.away}`}|${lastN}${cxi}`.toLowerCase();
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

  // user-adjusted XI beats any published/predicted lineup — they're overriding the team news call
  if (custom && hId && aId) {
    const [ht, at] = await Promise.all([getTeam(hId), getTeam(aId)]);
    const pick = (t, ids) => ids.map((id) => t.players.find((p) => p.id === Number(id))).filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, position: p.position }));
    const hx = pick(ht, spec.homeXI), ax = pick(at, spec.awayXI);
    if (hx.length && ax.length) { homeXI = hx; awayXI = ax; lineupStatus = 'custom'; }
  }

  if (!homeXI && matchId) {
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
  // per-match TEAM stat logs (corners, throw-ins, shots/SoT, cards, fouls, offsides), the sample the
  // team markets are scored on. Best-effort: an unavailable log just means no team stat legs.
  let homeTS = [], awayTS = [];
  if (hId && aId) {
    try { [homeTS, awayTS] = await Promise.all([teamMatchStats(hId), teamMatchStats(aId)]); }
    // logged, not swallowed: a silent [] here is indistinguishable from "this team has no team legs"
    catch (e) { console.log('  team stat log unavailable:', e?.message || e); }
  }
  // how strong was each side's recent opposition, without this, beating Wycombe reads like beating
  // Man City and the weaker team can come out rated higher.
  const W = await opponentStrength([homeForm, awayForm]).catch(() => null);
  // opponent profile each side faces (goals form + shot/SoT chance profile) + each side's match control
  const profileOf = (form, ch) => {
    const g = weightedGoals(form, W);
    return { ga: g?.ga ?? null, gf: g?.gf ?? null, sa: ch?.sa, sotA: ch?.sotA, sf: ch?.sf, sotF: ch?.sotF };
  };
  const homeOpp = profileOf(awayForm, awayCh); // home XI faces the away team
  const awayOpp = profileOf(homeForm, homeCh);
  const homeControl = controlOf(homeForm, homeCh, awayForm, awayCh, W);
  const awayControl = -homeControl;            // zero-sum by construction (edges negate)
  console.log(`  control ${homeName} ${homeControl.toFixed(2)} / ${awayName} ${awayControl.toFixed(2)} ` +
    `(competitive form n=${homeForm.length}/${awayForm.length}, team-stat log n=${homeTS.length}/${awayTS.length})`);

  // progress to the console: a scan is minutes long on a cold cache, and a player whose stats fail
  // is skipped silently below — without this line a half-empty scan looks identical to a good one.
  const t0 = Date.now();
  console.log(`scan ${homeName} v ${awayName} — ${roster.length} players, lineup=${lineupStatus}, lastN=${lastN}`);
  let done = 0, failed = 0;
  const recs = await pool(roster, 10, async (pl) => {
    try {
      const rec = await playerRecords(pl.id, lastN);
      console.log(`  [${++done}/${roster.length}] ${pl.name} — ${rec.records.length} matches`);
      return { pl, rec };
    } catch (e) {
      failed++; done++;
      console.log(`  [${done}/${roster.length}] ${pl.name} — FAILED: ${e?.message || e}`);
      return null;
    }
  });
  console.log(`scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${failed} player(s) failed)`);

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
  // team STAT legs (corners, throw-ins, shots/SoT, cards, fouls, offsides), per side + match totals
  legs.push(...teamStatLegs(homeName, homeTS, homeOpp, homeControl));
  legs.push(...teamStatLegs(awayName, awayTS, awayOpp, awayControl));
  legs.push(...matchStatLegs(homeTS, awayTS));

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

  const slimXI = (xi) => xi.map((p) => ({ id: p.id, name: p.name }));
  const out = {
    fixture: `${homeName} v ${awayName}`, home: homeName, away: awayName, homeId: hId, awayId: aId,
    xi: { home: slimXI(homeXI), away: slimXI(awayXI) }, // the XI actually used — feeds the UI's editor
    lineupStatus, rotationNote, legs,
    // game-script inputs kept so recommend() can RE-SCORE every leg once the capture supplies the
    // 1X2 price, the market prices a matchup better than a handful of results ever will.
    script: { homeName, awayName, homeOpp, awayOpp, formControl: homeControl },
  };
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

// Team STAT legs from a per-match team-stat log. `series` is the count for THIS team each match, so
// a line is scored exactly like a player prop: hit-rate → Wilson lower bound → game-script factor.
// corrKey is per team+market, so a parlay can't stack "over 3.5" and "over 4.5 corners" of one side.
function statLegsFrom(label, team, recs, scope, factorFor, isTeamSide) {
  const legs = [];
  for (const [mk, m] of Object.entries(TEAM_MARKETS)) {
    if (m.scope !== scope) continue;
    const series = recs.map((r) => {
      const mine = r.for?.[m.stat];
      if (mine == null) return null;
      if (scope !== 'match') return mine;
      const theirs = r.against?.[m.stat];
      return theirs == null ? null : mine + theirs;
    }).filter((v) => v != null);
    if (!series.length) continue;
    const factor = isTeamSide ? factorFor(mk) : 1;   // match totals are both sides at once → no side-specific script
    for (const line of m.lines) {
      const hits = series.filter((v) => v > line).length;
      const pRaw = wilsonLower(hits, series.length);
      legs.push({
        id: `${label}|${mk}|${line}`, player: label, playerId: null, team,
        marketKey: mk, market: m.label, line, kind: m.kind, isTeam: true, naive: false,
        corrKey: `${team}|${mk}`,
        sample: series.length, hits, pRaw, p: clampP(pRaw * factor),
        l10: hits / series.length, l5: null, season: hits / series.length,
        odds: null, implied: null, edge: null,
      });
    }
  }
  return legs;
}
const teamStatLegs = (name, recs, opp, control) =>
  statLegsFrom(name, name, recs || [], 'team', (mk) => gameFactor(mk, opp, control), true);

// Match totals (total corners / total throw-ins) need BOTH sides' logs. Each side's log already
// carries for+against, so either one gives the match total, use the longer sample.
const matchStatLegs = (homeTS, awayTS) =>
  statLegsFrom('Match', 'Match', ((homeTS || []).length >= (awayTS || []).length ? homeTS : awayTS) || [], 'match', () => 1, false);

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
        // team stat markets: match totals key off the line alone, team totals also need the side the
        // capture named (corner/throw-in grids carry the team in the market title or the row label)
        if (leg.marketKey.startsWith('match_')) return lineEq(r);
        if (leg.marketKey.startsWith('team_') && leg.marketKey !== 'team_goals') {
          return lineEq(r) && teamNameMatch(r.player, leg.team);
        }
        return false;                                          // team_goals: bet365 has no clean match here
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

// Re-score every leg against a NEW control value. Legs keep their Wilson probability (`pRaw`), so
// swapping the game-script input is just re-applying gameFactor, no re-fetch, no re-scan.
function rescoreLegs(legs, script, homeControl) {
  return legs.map((l) => {
    if (l.pRaw == null || !l.team || l.team === 'Match') return l;   // match totals carry no side script
    const isHome = l.team === script.homeName;
    if (!isHome && l.team !== script.awayName) return l;
    const opp = isHome ? script.homeOpp : script.awayOpp;
    const control = isHome ? homeControl : -homeControl;
    return { ...l, p: clampP(l.pRaw * gameFactor(l.marketKey, opp, control)) };
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
// A 40-leg pool would be C(40,7) = 18.6M combos at the top size, so the sub-pool shrinks as k grows:
// the small parlays (where a team leg actually gets used) see the whole pool, the monster multis see
// only the strongest prefix. Total combos stay ~50k, same order as the old 20-leg pool.
const K_POOL = { 2: 40, 3: 40, 4: 28, 5: 20, 6: 16, 7: 14 };

function buildParlays(legs, { poolSize = 40, maxSize = 6, haveOdds = false } = {}) {
  // naive (Result/DC): form can't price a matchup — excluded UNTIL the market prices it (l.odds set),
  // at which point its p is the market-implied prob. The p≥0.55 cut below then only keeps it for a
  // clear favourite, i.e. exactly the "winner all but known" game the user wants to stack.
  const strong = legs.filter((l) => l.sample >= 6 && (!l.naive || l.odds > 1));
  // Rank INSIDE each leg type. Player legs outnumber team legs by ~60:1 (828 legs scored, ~13 of them
  // team), so a single global top-N was always all players, that, not the scoring, is why parlays
  // came back as five player props. Team and player legs now compete only against their own kind.
  const rank = (src) => {
    const byProb = src.filter((l) => l.p >= 0.55).sort((a, b) => b.p - a.p).slice(0, 14);
    const byEdge = haveOdds ? src.filter((l) => l.odds > 1 && l.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 14) : [];
    const seen = new Set(), out = [];
    for (const l of [...byProb, ...byEdge]) if (!seen.has(l.id)) { seen.add(l.id); out.push(l); }
    return out;
  };
  const teamRanked = rank(strong.filter((l) => l.isTeam));
  const playerRanked = rank(strong.filter((l) => !l.isTeam));
  // Interleave the two rankings so every PREFIX of the pool is balanced, the per-k sub-pools below
  // slice a prefix, so this is what keeps team legs in the big multis too. With no team legs
  // available (early season, thin competitive sample) it degrades to the player ranking alone.
  const pool = [], seen = new Set();
  for (let i = 0; i < Math.max(teamRanked.length, playerRanked.length) && pool.length < poolSize; i++) {
    for (const l of [teamRanked[i], playerRanked[i]]) {
      if (!l || seen.has(l.id) || pool.length >= poolSize) continue;
      seen.add(l.id); pool.push(l);
    }
  }

  const out = [];
  for (let k = 2; k <= Math.min(maxSize, pool.length); k++) {
    const sub = pool.slice(0, Math.min(pool.length, K_POOL[k] ?? 14));
    for (const idx of kCombos(sub.length, k)) {
      const ls = idx.map((i) => sub[i]);
      if (new Set(ls.map((l) => l.corrKey || l.player)).size !== ls.length) continue; // ≤1 leg per player / team-market
      if (haveOdds && !ls.every((l) => l.odds > 1)) continue;                 // priced parlays only, so returns/EV are real
      out.push(combineParlay(ls));
    }
  }
  return { parlays: out, poolSize: pool.length, teamPool: teamRanked.length, playerPool: playerRanked.length };
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
  // The market prices a matchup better than a handful of results can. If the capture carries the
  // 1X2, de-vig it and re-score every leg against that control BEFORE merging prices, otherwise a
  // clear favourite/underdog game keeps whatever the thin form sample implied.
  const oddsControl = rawHaveOdds && data.script ? controlFromOdds(oddsRows, data.home, data.away) : null;
  const base = oddsControl == null ? data.legs : rescoreLegs(data.legs, data.script, oddsControl);
  const legs = rawHaveOdds ? withOdds(base, oddsRows) : base.map((l) => ({ ...l }));
  const matched = legs.filter((l) => l.odds > 1).length;
  // Captured odds only "count" if they actually matched players in THIS fixture. A capture for a
  // different match merges nothing → fall back to confidence ranking and warn, don't show blanks.
  const haveOdds = rawHaveOdds && matched > 0;
  // pre-odds only the ≤3-leg "likely" tier renders — don't build 100k+ big combos nobody sees
  const { parlays, poolSize, teamPool, playerPool } = buildParlays(legs, { haveOdds, maxSize: haveOdds ? 7 : 3 });

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
    // monster multis: 5–7 legs, floor 0.5% — payout hunting, most will lose (and the cap bites)
    longshot: clusterTier(parlays.filter((p) => p.legs.length >= 5 && p.prob >= 0.005)
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
    homeId: data.homeId, awayId: data.awayId, xi: data.xi,
    lineupStatus: data.lineupStatus, rotationNote: data.rotationNote,
    topLegs, tiers,
    meta: {
      legsScored: data.legs.length, parlayPool: poolSize, parlaysBuilt: parlays.length,
      teamPool, playerPool,
      control: oddsControl ?? data.script?.formControl ?? null,
      controlSource: oddsControl != null ? 'bet365 1X2 (de-vigged)' : 'competitive form (opponent-adjusted)',
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

    // longshot tier feed: maxSize 7 must actually produce 5–7 leg parlays from a priced pool
    const seven = 'ABCDEFG'.split('').map((c, i) => ({ id: c, sample: 10, p: 0.6, odds: 1.9 + i * 0.1, player: c, market: 'Shots' }));
    const sizes = new Set(buildParlays(seven, { haveOdds: true, maxSize: 7 }).parlays.map((p) => p.legs.length));
    assert(sizes.has(5) && sizes.has(6) && sizes.has(7), `maxSize 7 builds 5/6/7-leg combos, got sizes ${[...sizes]}`);
    // --- opponent-adjusted form: beating a strong side must outrank beating a weak one -----------
    const W = new Map([[1, 1.4], [2, 0.7]]);                                   // team 1 strong, team 2 weak
    const vsStrong = weightedGoals([{ gf: 2, ga: 1, oppId: 1 }], W);
    const vsWeak = weightedGoals([{ gf: 2, ga: 1, oppId: 2 }], W);
    assert(vsStrong.gf > vsWeak.gf, 'the same 2 goals count for more against a strong side');
    assert(vsStrong.ga < vsWeak.ga, 'the same goal conceded counts for more against a weak side');
    // the Liverpool-v-Ipswich shape: identical raw form, but one side played much better opposition
    const cStrongSched = controlOf([{ gf: 2, ga: 1, oppId: 1 }], null, [{ gf: 2, ga: 1, oppId: 2 }], null, W);
    assert(cStrongSched > 0.1, `tougher schedule at equal raw form must rate higher, got ${cStrongSched.toFixed(3)}`);
    assert(near(controlOf([{ gf: 2, ga: 1, oppId: 1 }], null, [{ gf: 2, ga: 1, oppId: 1 }], null, W), 0), 'same opponents + same form = dead even');

    // --- market anchor: de-vigged 1X2 must dominate a thin form sample --------------------------
    const rows1x2 = [
      { marketKey: 'result', player: 'Liverpool', odds: '1.20', line: null },
      { marketKey: 'result', player: 'Draw', odds: '7.00', line: null },
      { marketKey: 'result', player: 'Ipswich', odds: '13.00', line: null },
    ];
    const cOdds = controlFromOdds(rows1x2, 'Liverpool', 'Ipswich');
    assert(cOdds > 0.65, `1.20 v 13.00 is a lopsided game, got control ${cOdds?.toFixed(3)}`);
    assert(controlFromOdds([rows1x2[0]], 'Liverpool', 'Ipswich') === null, 'one price only -> no odds control');
    // re-scoring with that control must SUPPRESS the underdog's attack, not boost it
    const script = { homeName: 'Liverpool', awayName: 'Ipswich', homeOpp: ghana, awayOpp: eng };
    const dogLeg = { id: 'd', team: 'Ipswich', marketKey: 'team_goals', pRaw: 0.7, p: 0.79, sample: 9 };
    const before = dogLeg.p, after = rescoreLegs([dogLeg], script, cOdds)[0].p;
    assert(after < before, `underdog attack must be tempered by the market anchor (${before} -> ${after})`);

    // --- team STAT markets: a real log must produce scored legs ---------------------------------
    const log = Array.from({ length: 8 }, () => ({ for: { corners: 6, throws: 20, shots: 14, sot: 5, cards: 2, fouls: 11, offsides: 1 },
                                                   against: { corners: 3, throws: 22, shots: 9, sot: 3, cards: 1, fouls: 12, offsides: 2 } }));
    const tsl = teamStatLegs('Liverpool', log, ghana, 0.5);
    assert(tsl.some((l) => l.marketKey === 'team_corners'), 'team corners scored');
    assert(tsl.some((l) => l.marketKey === 'team_throws'), 'team throw-ins scored');
    assert(tsl.every((l) => l.isTeam && l.sample === 8), 'team stat legs carry isTeam + the log sample');
    const c45 = tsl.find((l) => l.marketKey === 'team_corners' && l.line === 4.5);
    assert(near(c45.season, 1), '6 corners every game clears the 4.5 line every time');
    const msl = matchStatLegs(log, []);
    const mc = msl.find((l) => l.marketKey === 'match_corners' && l.line === 8.5);
    assert(near(mc.season, 1), 'match corners = for + against = 9, clears 8.5');
    assert(msl.every((l) => l.team === 'Match'), 'match totals are not attributed to a side');

    // --- captured corner/throw-in prices must actually reach the team stat legs -----------------
    const cornerLeg = tsl.find((l) => l.marketKey === 'team_corners' && l.line === 4.5);
    const matchLeg = msl.find((l) => l.marketKey === 'match_corners' && l.line === 8.5);
    const throwLeg = tsl.find((l) => l.marketKey === 'team_throws' && l.line === 18.5);
    const capture = [
      { marketKey: 'team_corners', player: 'Liverpool', line: 4.5, odds: '1.80' },
      { marketKey: 'match_corners', player: 'Over 8.5', line: 8.5, odds: '1.95' },
      { marketKey: 'team_throws', player: 'Liverpool FC', line: 18.5, odds: '2.10' },
    ];
    const merged = withOdds([cornerLeg, matchLeg, throwLeg], capture);
    assert(near(merged[0].odds, 1.80), `team corners priced, got ${merged[0].odds}`);
    assert(near(merged[1].odds, 1.95), `match corners priced off the line alone, got ${merged[1].odds}`);
    assert(near(merged[2].odds, 2.10), `team throw-ins matched through a loose team name, got ${merged[2].odds}`);
    assert(merged[0].edge != null, 'a priced team stat leg gets an edge');
    // the wrong side, and the wrong line, must NOT merge
    const wrong = withOdds([cornerLeg], [{ marketKey: 'team_corners', player: 'Ipswich Town', line: 4.5, odds: '1.80' }]);
    assert(wrong[0].odds == null, 'another team\'s corner price must not merge');
    const offLine = withOdds([cornerLeg], [{ marketKey: 'team_corners', player: 'Liverpool', line: 5.5, odds: '1.80' }]);
    assert(offLine[0].odds == null, 'a different line must not merge');

    // --- pool rebalance: team legs must survive alongside 60x as many player legs ---------------
    const manyPlayers = Array.from({ length: 60 }, (_, i) => ({ id: 'p' + i, sample: 10, p: 0.9, odds: 1.5, player: 'P' + i, market: 'Shots' }));
    const someTeam = Array.from({ length: 6 }, (_, i) => ({ id: 't' + i, sample: 10, p: 0.6, isTeam: true, odds: 1.9, player: 'Liverpool', corrKey: 'L|m' + i, market: 'Team corners' }));
    const rb = buildParlays([...manyPlayers, ...someTeam], { haveOdds: false, maxSize: 3 });
    assert(rb.teamPool > 0, 'team legs get their own ranking, not crowded out by 60 stronger player legs');
    assert(rb.parlays.some((p) => p.legs.some((l) => l.isTeam)), 'team legs actually reach built parlays');
    // and the combination budget must stay sane at the full pool size
    assert(rb.parlays.length < 200000, `combination budget bounded, got ${rb.parlays.length}`);
    // thin-sample guard still bites: a 3-game team log can't reach a parlay
    const thin = someTeam.map((l) => ({ ...l, sample: 3 }));
    assert(buildParlays([...manyPlayers, ...thin], { haveOdds: false, maxSize: 3 }).teamPool === 0, 'sample<6 team legs stay out');

    console.log('OK, clusterParlays + team Result priced-in + game-script + opponent-adjusted form + de-vig anchor + team stat markets + pool rebalance.');
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
