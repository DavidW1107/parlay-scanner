# Parlay Scanner

Automated player-prop **value finder**. Pulls every starter's real match-by-match stats from
FotMob, scores each market/line by a **conservative probability** (Wilson lower bound — it shrinks
small-sample hot streaks instead of trusting them), merges live bet365 odds, and **builds parlays
ranked into risk tiers** with win-probability, combined odds and €10 returns.

Local only. No accounts, no data leaves the machine.

> **Not a money printer.** Bookmakers price most edges; player props carry real variance; and
> legs from the same match are *correlated*, so a parlay's combined probability here is an
> optimistic upper bound, not a guarantee. This is a filter for the *best-supported* bets — a
> ranking tool, not a lock machine. Bet responsibly (18+, GambleAware).

## Run

One-time setup:

```bash
npm install
npx playwright install chromium      # the browser FotMob is read through
```

**Desktop app (tkinter):**

```bash
python app.py                        # boots the data server + opens the window
```

**Or in the browser:**

```bash
npm start                            # → http://localhost:5757
```

Then:

1. Type two teams (e.g. `Man City` / `Arsenal`), set **Last N** (default 18 — bigger sample =
   tighter probabilities), and hit **★ Find value**.
2. Both likely XIs are scanned — every player × every market × every standard line. The
   **★ Recommendations** tab fills with the top single legs (by confidence) and parlays in tiers:
   **Bankers** (most likely), **Longshots** (biggest return), and — once odds are merged —
   **Value** (best expected value).
3. Click **Capture bet365** and drive your signed-in browser to the fixture's Player Markets
   (see below). It reads the odds, merges them, and re-ranks everything with real edge / EV / €10
   returns. Green = positive expected value.

Manual drill-down still works: **Scan squads**, double-click any player for the full hit-rate
grid, double-click an Odds cell to price one leg by hand.

> Hit-rate counts only games where the player played ≥60 min (cameos excluded). Leg probability
> is the Wilson lower bound of the last-N hit rate. Team legs are scored the same way off the team's
> competitive matches (friendlies excluded). Parlay probability multiplies legs
> (independence assumed — same-match legs correlate, so treat combined odds as optimistic).

Change the port with `PORT=5858 npm start`.

## How it works

```
app.py          tkinter desktop app — Recommendations view + manual grids; boots the server
web/            browser UI (no framework) — squad pills, deep-dive grid, live edge calc
server.js       node:http — /api/fixture · /api/deepdive · /api/recommend + static files
src/scanner.js  the brain — scans both XIs, Wilson-scores every leg, merges odds, builds parlays
src/fotmob.js   data layer — Playwright reads FotMob's embedded __NEXT_DATA__; disk-cached
src/scan.js     merges recentMatches + per-match stats into newest-first records
src/engine.js   pure math — hit-rate, implied prob, edge, Wilson lower bound, parlay combine
src/markets.js  bet365 market catalog (player + team) → canonical FotMob stat key
capture-bet365.mjs  attended, read-only bet365 odds capture (you drive a signed-in browser)
```

Finished-match payloads are immutable, so they cache forever under `.cache/`; player/team
data caches for a few hours. First scan of a fixture is the slow one.

### Self-checks

```bash
npm test            # engine math (pure, offline, deterministic)
npm run check:fotmob   # live: hits FotMob, prints Haaland's resolved stats
```

## Markets

**Player:** Shots · Shots on target · Fouls committed · Fouls won · Tackles · Passes ·
Chances created · Goalkeeper saves · Offsides · Anytime goalscorer · Anytime assist · To be booked.

**Team:** Match result · Double chance · Team goals · Total goals · BTTS · Team corners ·
Total corners · Team throw-ins · Total throw-ins · Team shots · Team shots on target ·
Team cards · Team fouls · Team offsides.

Team stat markets are counted off FotMob's per-match team stats block (`teamMatchStats`), so their
sample is the team's **competitive** match count, not the player-level 18. Early in a season that
means most team legs sit below the `sample >= 6` floor and are held back deliberately, filling in as
league games are played.

### Competitive matches only

Pre-season friendlies are excluded from every team-level calculation, `form`, `teamChances` and the
team stat log. They used to dominate: in early September a team's `form` was 6 friendlies to 2 league
games, so a promoted side beating Wycombe and Oxford in July read as a stronger attack than a
Premier League side that lost a friendly 2-4, and the scanner rated the fixture close to a coin flip.

### How a matchup's strength is judged

`control` (−1..+1) drives the whole game-script adjustment: how much one side dominates, which
tempers a favourite's attack and spikes the underdog's keeper and defence. Two sources, best first:

1. **De-vigged bet365 1X2**, once a capture contains it. The market prices a matchup far better than
   a handful of results can. The capture takes the Draw price purely for this, stripping vig from
   home/away alone pushes the draw's share onto both and overstates the favourite. Every leg is
   re-scored against this control before prices are merged.
2. **Opponent-adjusted competitive form**, otherwise. Each result is weighted by that opponent's own
   goal difference, so scoring against a strong side counts for more and conceding to a weak one
   counts against you. Raw form is blind to who you played, which is how the weaker team could come
   out rated higher.

## bet365 odds — how the capture works

`capture-bet365.mjs` (the **Capture bet365** button). bet365 blocks login on any browser
Playwright *launches* (automation fingerprint), so the capture never launches one — it **attaches
over CDP to a real Edge/Chrome**. The script starts Edge with a debug port + a dedicated profile
(`.b365cdp/`, git-ignored — log in there once, it persists), then attaches. bet365 sees a genuine
browser, so login works exactly like a tab you opened yourself.

You sign in, open the fixture's Player Markets, and click the floating gold **CAPTURE ODDS**
button it injects. Only then does it read — it clicks through the stat tabs (Shots / SoT / Fouls /
Tackles, **labels only — it never clicks a price or the betslip, and never closes your browser**),
re-aligns the odds to player rows, and writes `_b365_capture.json`. The app fuzzy-matches names and
merges them in.

> The over/under grid is obfuscated (rotating class names, odds in positional columns), so that
> part of the extractor can need a tweak after a bet365 reskin, and every capture writes a `_debug`
> block for exactly that. Anytime markets (To Score / Assist / Booked) are the robust ones.

### Corners and throw-ins

These are not in the Player Markets pane. bet365 keeps them behind the fixture's own market-group
nav (`Main | Goals | Corners | Bookings | ...`), which swaps the market list in place, so the capture
now clicks through to them after sweeping the pane you opened. Each group gets the same treatment:
expand every section, walk every tab, scroll to force lazy rows. Only non-anchor labels are clicked
and the URL is checked after each one, so a click can never take you off the fixture; if it somehow
does, the script steps back and skips that group.

Only the **over** side of a plain total is kept, since every team stat line the scanner scores is an
over. `10+` maps to over-9.5; a bare whole-number line is a push market (exactly 10 refunds) and is
skipped rather than priced wrong. Handicaps, Asian lines, halves, `Most Corners` and `First Corner`
are all ignored.

> The mapping is written against bet365's market **names**, not a verified live DOM, so it wants one
> attended run to confirm. If `team_corners` / `match_throws` come back empty, read
> `_debug.cornerThrowMisses` in `_b365_capture.json`: it lists the exact group / column / row text of
> every corner or throw-in cell that was seen but matched no rule, which is all the mapper needs.

Check the mapping rules without a browser:

```bash
node capture-bet365.mjs --selftest
```
