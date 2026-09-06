// bet365 player-prop markets → canonical stat + evaluation kind.
// kind 'ou'      = over/under a .5 line (bet365 lines are virtually all X.5 → no push).
// kind 'atleast' = "anytime" style, hit when stat >= n.
// `stat` keys match the per-match record built in scan.js (which merges recentMatches + matchDetails).
export const MARKETS = {
  shots:    { label: 'Shots',             stat: 'shots',    kind: 'ou' },
  sot:      { label: 'Shots on target',   stat: 'sot',      kind: 'ou' },
  fouls:    { label: 'Fouls committed',   stat: 'fouls',    kind: 'ou' },
  fouled:   { label: 'Fouls won',         stat: 'fouled',   kind: 'ou' },
  tackles:  { label: 'Tackles',           stat: 'tackles',  kind: 'ou' },
  passes:   { label: 'Passes',            stat: 'passes',   kind: 'ou' },
  chances:  { label: 'Chances created',   stat: 'chances',  kind: 'ou' },
  saves:    { label: 'Goalkeeper saves',  stat: 'saves',    kind: 'ou' },
  offsides: { label: 'Offsides',          stat: 'offsides', kind: 'ou' },
  headed_sot:        { label: 'Headed shots on target', stat: 'headed_sot',        kind: 'ou' },
  shots_outside_box: { label: 'SoT outside box',        stat: 'shots_outside_box', kind: 'ou' },
  goals:    { label: 'Anytime goalscorer',stat: 'goals',    kind: 'atleast', n: 1 },
  assists:  { label: 'Anytime assist',    stat: 'assists',  kind: 'atleast', n: 1 },
  card:     { label: 'To be booked',      stat: 'card',     kind: 'atleast', n: 1 },
};

// Team-level stat markets, counted off each side's own recent COMPETITIVE matches (friendlies are
// excluded upstream, pre-season noise was the single biggest source of bogus team probabilities).
// scope 'team'  = that team's own count for the match; 'match' = both teams' counts added together.
// `stat` keys match the per-match team-stat record built in fotmob.js `teamStatsFrom`.
export const TEAM_MARKETS = {
  team_corners:  { label: 'Team corners',          stat: 'corners',  scope: 'team',  kind: 'ou', lines: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5] },
  match_corners: { label: 'Total corners',         stat: 'corners',  scope: 'match', kind: 'ou', lines: [7.5, 8.5, 9.5, 10.5, 11.5, 12.5] },
  team_throws:   { label: 'Team throw-ins',        stat: 'throws',   scope: 'team',  kind: 'ou', lines: [12.5, 15.5, 18.5, 21.5, 24.5] },
  match_throws:  { label: 'Total throw-ins',       stat: 'throws',   scope: 'match', kind: 'ou', lines: [28.5, 32.5, 36.5, 40.5, 44.5] },
  team_shots:    { label: 'Team shots',            stat: 'shots',    scope: 'team',  kind: 'ou', lines: [8.5, 10.5, 12.5, 14.5, 16.5] },
  team_sot:      { label: 'Team shots on target',  stat: 'sot',      scope: 'team',  kind: 'ou', lines: [2.5, 3.5, 4.5, 5.5, 6.5] },
  team_cards:    { label: 'Team cards',            stat: 'cards',    scope: 'team',  kind: 'ou', lines: [0.5, 1.5, 2.5, 3.5] },
  team_fouls:    { label: 'Team fouls',            stat: 'fouls',    scope: 'team',  kind: 'ou', lines: [7.5, 9.5, 11.5, 13.5, 15.5] },
  team_offsides: { label: 'Team offsides',         stat: 'offsides', scope: 'team',  kind: 'ou', lines: [0.5, 1.5, 2.5] },
};

// Free-text bet365 market name → catalog key (used by the manual-paste parser).
export function matchMarket(text) {
  const t = text.toLowerCase();
  // team/match totals first, "team shots on target" must not fall through to the player SoT rule
  const teamish = /\bteam\b|total|match/.test(t);
  if (/corner/.test(t)) return teamish && /total|match/.test(t) ? 'match_corners' : 'team_corners';
  if (/throw/.test(t)) return teamish && /total|match/.test(t) ? 'match_throws' : 'team_throws';
  if (teamish && /shots?\s+on\s+target|on target/.test(t)) return 'team_sot';
  if (teamish && /\bshots?\b/.test(t)) return 'team_shots';
  if (/headed/.test(t) && /target/.test(t)) return 'headed_sot';            // before the general SoT/shots rules
  if (/outside.*box/.test(t) && /target/.test(t)) return 'shots_outside_box';
  if (/shots?\s+on\s+target|on target/.test(t)) return 'sot';
  if (/\bshots?\b/.test(t)) return 'shots';
  if (/fouls?\s+(won|drawn|suffered)|won.*foul/.test(t)) return 'fouled';
  if (/\bfouls?\b/.test(t)) return 'fouls';
  if (/\btackles?\b/.test(t)) return 'tackles';
  if (/\bpasses?\b/.test(t)) return 'passes';
  if (/chances?\s+created|key\s+passes?|assists?\s+\+/.test(t)) return 'chances';
  if (/\bsaves?\b/.test(t)) return 'saves';
  if (/\boffsides?\b/.test(t)) return 'offsides';
  if (/goalscorer|to\s+score|anytime\s+score/.test(t)) return 'goals';
  if (/assist/.test(t)) return 'assists';
  if (/booked|card|caution/.test(t)) return 'card';
  return null;
}
