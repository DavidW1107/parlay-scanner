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
> is the Wilson lower bound of the last-N hit rate. Parlay probability multiplies legs
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
src/markets.js  bet365 market catalog → canonical FotMob stat key
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

Shots · Shots on target · Fouls committed · Fouls won · Tackles · Passes · Chances created ·
Goalkeeper saves · Offsides · Anytime goalscorer · Anytime assist · To be booked.

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
> part of the extractor can need a tweak after a bet365 reskin — every capture writes a `_debug`
> block for exactly that. Anytime markets (To Score / Assist / Booked) are the robust ones.
