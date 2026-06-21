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

// Free-text bet365 market name → catalog key (used by the manual-paste parser).
export function matchMarket(text) {
  const t = text.toLowerCase();
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
