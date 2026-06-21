// Orchestrator: merge FotMob recentMatches (cheap) + matchDetails (rich) into
// newest-first per-match records, then run the engine against offered odds.
import { getPlayer, getMatch, STAT, close } from './fotmob.js';
import { MARKETS } from './markets.js';
import { evalMarket, marketLine } from './engine.js';

// Standard bet365 lines per market for the deep-dive grid.
export const LINES = {
  shots: [0.5, 1.5, 2.5, 3.5],
  sot: [0.5, 1.5, 2.5],
  fouls: [0.5, 1.5, 2.5],
  fouled: [0.5, 1.5, 2.5],
  tackles: [0.5, 1.5, 2.5, 3.5],
  passes: [24.5, 34.5, 44.5, 54.5],
  chances: [0.5, 1.5, 2.5],
  saves: [1.5, 2.5, 3.5, 4.5],
  offsides: [0.5, 1.5],
  headed_sot: [0.5, 1.5],
  shots_outside_box: [0.5, 1.5],
  goals: [0], assists: [0], card: [0], // anytime markets
};

const RICH = ['shots', 'sot', 'fouls', 'fouled', 'tackles', 'passes', 'chances', 'saves', 'offsides', 'headed_sot', 'shots_outside_box'];

export async function playerRecords(playerId, lastN = 10) {
  const p = await getPlayer(playerId);
  const matches = [...p.recentMatches]
    .filter((m) => m.homeScore != null && !m.onBench) // finished, featured
    .sort((a, b) => new Date(b.matchDate.utcTime) - new Date(a.matchDate.utcTime))
    .slice(0, lastN);

  const records = [];
  for (const m of matches) {
    // ponytail: sequential fetch — matchDetails are cached so only the first scan is slow. Parallelize in the fixture-wide orchestrator if needed.
    const rec = {
      date: m.matchDate.utcTime,
      opponent: m.opponentTeamName,
      isHome: m.isHomeTeam,
      minutes: m.minutesPlayed ?? 0,
      goals: m.goals ?? 0,
      assists: m.assists ?? 0,
      card: (m.yellowCards ?? 0) + (m.redCards ?? 0) >= 1 ? 1 : 0,
    };
    try {
      const md = await getMatch(m.matchPageUrl);
      const ps = md.players[playerId];
      if (ps) for (const k of RICH) rec[k] = STAT.resolve(ps.stats, k) ?? 0;
    } catch {
      /* match stats unavailable — cheap markets (goals/assists/cards) still evaluate */
    }
    records.push(rec);
  }
  return { name: p.name, records };
}

// oddsRows: [{ marketKey, line, odds, fairProb? }]
export async function scanPlayer(playerId, oddsRows, lastN = 10) {
  const { name, records } = await playerRecords(playerId, lastN);
  const rows = oddsRows
    .map((o) => {
      const m = MARKETS[o.marketKey];
      if (!m) return null;
      return evalMarket(records, m, o.line ?? 0, o.odds, { fairProb: o.fairProb });
    })
    .filter(Boolean)
    .sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99));
  return { player: name, sample: records.length, rows };
}

// Full per-player deep dive: every market × standard lines, hit-rate windows, NO odds needed.
// The UI overlays user-typed odds client-side to get edge.
export async function deepDive(playerId, lastN = 10) {
  const { name, records } = await playerRecords(playerId, lastN);
  const markets = {};
  for (const [key, market] of Object.entries(MARKETS)) {
    markets[key] = {
      label: market.label,
      kind: market.kind,
      lines: (LINES[key] || [0.5]).map((line) => marketLine(records, market, line)),
    };
  }
  return { id: playerId, player: name, sample: records.length, markets };
}

// Focused stats for ONE recommended leg: hit-rate windows for that exact market/line, the per-90
// average for the stat, and the game-by-game log. Backs the double-click drill-down.
export async function legStat(playerId, marketKey, line, lastN = 18) {
  const m = MARKETS[marketKey];
  if (!m) throw new Error('unknown market: ' + marketKey);
  const { name, records } = await playerRecords(playerId, lastN);
  const stat = m.stat;
  const ln = line === '' || line == null ? 0 : Number(line);
  const ml = marketLine(records, m, ln);
  // per-90: total stat over total minutes (only games actually played)
  let sv = 0, sm = 0;
  for (const r of records) { const min = r.minutes ?? 0; if (min > 0) { sv += r[stat] ?? 0; sm += min; } }
  const per90 = sm > 0 ? +((sv / sm) * 90).toFixed(2) : null;
  const hit = m.kind === 'ou' ? (v) => v > ln : (v) => v >= (m.n ?? 1);
  const log = records.slice(0, 12).map((r) => ({
    date: (r.date || '').slice(0, 10), opp: r.opponent, isHome: r.isHome,
    value: r[stat] ?? 0, minutes: r.minutes ?? 0, hit: hit(r[stat] ?? 0),
  }));
  return { player: name, market: m.label, line: ln, kind: m.kind, per90, sample: ml.sample, windows: ml.hitRate, log };
}

// --- demo: real Haaland data vs sample odds — run `node src/scan.js` ---
if (process.argv[1] === (await import('url')).fileURLToPath(import.meta.url)) {
  const odds = [
    { marketKey: 'goals', odds: 1.9 },
    { marketKey: 'shots', line: 2.5, odds: 1.83 },
    { marketKey: 'shots', line: 3.5, odds: 3.0 },
    { marketKey: 'sot', line: 0.5, odds: 1.28 },
    { marketKey: 'sot', line: 1.5, odds: 2.5 },
    { marketKey: 'fouled', line: 0.5, odds: 1.5 },
  ];
  const res = await scanPlayer(737066, odds, 8); // Haaland, last 8
  console.log(`\n${res.player} — last ${res.sample} games\n`);
  console.log('market            line  odds  impl%  L10    L5     season  edge');
  for (const r of res.rows) {
    const pct = (h) => (h.rate == null ? ' n/a ' : `${(h.rate * 100).toFixed(0)}%(${h.n})`.padEnd(6));
    console.log(
      r.market.padEnd(17),
      String(r.line).padStart(4),
      String(r.odds).padStart(5),
      `${r.impliedPct}%`.padStart(6),
      pct(r.hitRate.last10),
      pct(r.hitRate.last5),
      pct(r.hitRate.season),
      `${r.edge > 0 ? '+' : ''}${r.edge}pp`.padStart(7),
    );
  }
  await close();
}
