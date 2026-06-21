#!/usr/bin/env python3
"""Parlay Scanner — tkinter desktop front-end.

Boots the Node data server (server.js) as a child process and talks to its JSON API
(/api/fixture, /api/deepdive). Stats come from FotMob; you type the bet365 price and
read the edge (hit-rate minus the implied probability). Positive edge = value.

Stdlib only — tkinter, urllib, json, subprocess, threading. No pip installs.

Run:  python app.py        (needs `npm install` + `npx playwright install chromium` once)
Test: python app.py --selftest
"""
import datetime, json, os, re, shutil, subprocess, sys, threading, time, unicodedata
import urllib.request, urllib.parse
import tkinter as tk
from tkinter import ttk

BASE = "http://localhost:5757"
HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which("node") or "node"
GREEN, RED, GOLD = "#1b8a4b", "#c0392b", "#9a7a22"


# ---------- pure logic (mirrors src/engine.js + web/app.js) ----------
def to_decimal(s):
    """bet365 price string -> decimal odds. Accepts '1.83', '5/6', 'evens'."""
    s = (s or "").strip().lower()
    if not s:
        return None
    if s in ("evens", "evs"):
        return 2.0
    try:
        if "/" in s:
            a, b = s.split("/", 1)
            return float(a) / float(b) + 1 if float(b) else None
        d = float(s)
        return d if d > 1 else None
    except ValueError:
        return None


def edge_row(hr, raw):
    """hit-rate windows + typed odds -> (odds_str, impl, edge_pp, fair) display strings.
    Edge is driven by the L10 window, falling back to season — same rule as the engine."""
    odds = to_decimal(raw)
    base = hr["last10"]["rate"]
    if base is None:
        base = hr["season"]["rate"]
    shown = (raw or "").strip()
    if odds is None or base is None:
        return shown, "—", "—", "—", None
    imp = 100 / odds
    edge = base * 100 - imp
    return (shown, f"{imp:.1f}%", ("+" if edge >= 0 else "") + f"{edge:.1f}pp",
            f"{1 / base:.2f}", edge >= 0)


# ---------- node server lifecycle ----------
def ping():
    try:
        urllib.request.urlopen(BASE + "/", timeout=1)
        return True
    except Exception:
        return False


def start_server():
    """Return (proc, owns). owns=False if a server was already running (don't kill it)."""
    if ping():
        return None, False
    proc = subprocess.Popen([NODE, "server.js"], cwd=HERE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):  # up to ~30s
        if ping():
            return proc, True
        time.sleep(0.5)
    raise RuntimeError("node server.js did not come up on :5757 — run `npm install` first")


def api(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def pct(h, withn=False):
    if not h or h.get("rate") is None:
        return "—"
    s = f"{round(h['rate'] * 100)}%"
    return f"{s}/{h['n']}" if withn else s


def name_tokens(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return [t for t in re.split(r"[^a-z]+", s) if t]


def name_match(a, b):
    """Loose match: same surname, and first initials agree when both names give one.
    Handles 'E. Haaland' / 'Haaland' / 'Erling Haaland'."""
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb or ta[-1] != tb[-1]:
        return False
    if len(ta) >= 2 and len(tb) >= 2 and ta[0][0] != tb[0][0]:
        return False
    return True


# ---------- GUI ----------
class App:
    COLS = ("l10", "l5", "season", "home", "away", "odds", "imp", "edge", "fair")
    HEADS = ("L10", "L5", "Season", "Home", "Away", "Odds", "Impl", "Edge", "Fair")

    def __init__(self, root):
        self.root = root
        self.server = None
        self.owns_server = False
        self.tabs = {}  # player id -> tree widget
        self._last = None  # (home, away, lastN) of the last value scan, for the odds refresh
        self._match = None  # picked fixture {matchId, home, away, homeId, awayId} -> use its lineup
        self._reco_leg = {}  # recommendations row iid -> (playerId, name) for the stats drill-down
        root.title("Parlay Scanner")
        root.geometry("1180x760")
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        bar = ttk.Frame(root, padding=(10, 8))
        bar.pack(fill="x")
        self.e_home = self._entry(bar, "Home team", "Man City", 18)
        self.e_away = self._entry(bar, "Away team", "Arsenal", 18)
        ttk.Label(bar, text="Last N").pack(side="left", padx=(8, 2))
        self.e_n = ttk.Entry(bar, width=5)
        self.e_n.insert(0, "18")
        self.e_n.pack(side="left")
        self.btn_fx = ttk.Button(bar, text="📅 Fixtures", command=self.open_fixtures, state="disabled")
        self.btn_fx.pack(side="left", padx=(0, 8))
        self.btn_val = ttk.Button(bar, text="★ Find value", command=self.find_value, state="disabled")
        self.btn_val.pack(side="left")
        self.btn = ttk.Button(bar, text="Scan squads", command=self.scan, state="disabled")
        self.btn.pack(side="left", padx=8)
        self.btn_cap = ttk.Button(bar, text="Capture bet365", command=self.capture_bet365, state="disabled")
        self.btn_cap.pack(side="left")
        for e in (self.e_home, self.e_away, self.e_n):
            e.bind("<Return>", lambda _ev: self.find_value())
        for e in (self.e_home, self.e_away):  # typing a team by hand drops a picked fixture's matchId
            e.bind("<KeyRelease>", lambda _ev: setattr(self, "_match", None))

        self.status = ttk.Label(root, text="starting data server…", foreground=GOLD,
                                padding=(12, 0, 0, 4))
        self.status.pack(fill="x")

        pane = ttk.Panedwindow(root, orient="horizontal")
        pane.pack(fill="both", expand=True, padx=10, pady=(0, 6))
        squads = ttk.Frame(pane, width=300)
        self.home_lb, self.home_map = self._squad(squads, "Home")
        self.away_lb, self.away_map = self._squad(squads, "Away")
        pane.add(squads, weight=0)
        self.nb = ttk.Notebook(pane)
        pane.add(self.nb, weight=1)

        # primary view: the automated recommendations (always tab 0)
        rf = ttk.Frame(self.nb)
        self.reco = ttk.Treeview(rf, columns=("prob", "odds", "ret", "ev"), show="tree headings")
        self.reco.heading("#0", text="Recommendation")
        self.reco.column("#0", width=440, anchor="w")
        for c, h, w in (("prob", "P(win)", 70), ("odds", "Odds", 80), ("ret", "€10 →", 80), ("ev", "EV / edge", 96)):
            self.reco.heading(c, text=h)
            self.reco.column(c, width=w, anchor="center")
        rsb = ttk.Scrollbar(rf, command=self.reco.yview)
        self.reco.configure(yscrollcommand=rsb.set)
        rsb.pack(side="right", fill="y")
        self.reco.pack(side="left", fill="both", expand=True)
        self.reco.tag_configure("hdr", foreground=GOLD)
        self.reco.tag_configure("pos", foreground=GREEN)
        self.reco.tag_configure("neg", foreground=RED)
        self.reco.bind("<Double-Button-1>", self._reco_click)  # leg -> backing stats
        self.nb.add(rf, text="★ Recommendations")

        ttk.Label(root, foreground="#666", padding=(12, 0, 0, 6), wraplength=1140,
                  text="SINGLES (top list) are the edge — exact bet365 odds, place on bet365; double-click any leg for the "
                       "stats. PARLAYS over 1000/1 (→BF) exceed bet365's cap — place on BETFAIR (25-leg, uncapped). Parlay odds "
                       "are estimated from bet365 single prices; Betfair's are usually close but verify before staking. "
                       "Bet responsibly.").pack(fill="x")

        threading.Thread(target=self._boot, daemon=True).start()

    def _entry(self, parent, label, default, width):
        ttk.Label(parent, text=label).pack(side="left", padx=(0, 2))
        e = ttk.Entry(parent, width=width)
        e.insert(0, default)
        e.pack(side="left", padx=(0, 6))
        return e

    def _squad(self, parent, title):
        lf = ttk.Labelframe(parent, text=title, padding=4)
        lf.pack(fill="both", expand=True, pady=(0, 6))
        lb = tk.Listbox(lf, activestyle="none", borderwidth=0, highlightthickness=0)
        sb = ttk.Scrollbar(lf, command=lb.yview)
        lb.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        lb.pack(side="left", fill="both", expand=True)
        idmap = []
        lb.bind("<Double-Button-1>", lambda ev, l=lb, m=idmap: self._pick(l, m, ev))
        return lb, idmap

    # ----- server boot -----
    def _boot(self):
        try:
            self.server, self.owns_server = start_server()
        except Exception as e:
            return self.root.after(0, lambda: self._status(str(e), err=True))
        self.root.after(0, lambda: (self._status("ready — pick a fixture (📅) or enter two teams, then Find value"),
                                    self.btn_fx.config(state="normal"),
                                    self.btn_val.config(state="normal"),
                                    self.btn.config(state="normal"),
                                    self.btn_cap.config(state="normal")))

    # ----- helpers -----
    def _status(self, msg, err=False):
        self.status.config(text=msg, foreground=RED if err else GOLD)

    def _async(self, work, done):
        def run():
            try:
                res = work()
            except Exception as e:
                self.root.after(0, lambda: self._status(f"error: {e}", err=True))
                return
            self.root.after(0, lambda: done(res))
        threading.Thread(target=run, daemon=True).start()

    # ----- scan -----
    def scan(self):
        home, away = self.e_home.get().strip(), self.e_away.get().strip()
        if not home or not away:
            return
        self._status(f"resolving {home} vs {away} + likely XI…")
        q = f"/api/fixture?home={urllib.parse.quote(home)}&away={urllib.parse.quote(away)}"
        self._async(lambda: api(q), self._on_scan)

    def _on_scan(self, d):
        if "error" in d:
            return self._status(d["error"], err=True)
        self._render_squad(self.home_lb, self.home_map, d["home"])
        self._render_squad(self.away_lb, self.away_map, d["away"])
        self._status(f"{d['home']['name']} vs {d['away']['name']} — double-click a player to load")

    def _render_squad(self, lb, idmap, team):
        lb.delete(0, "end")
        idmap.clear()
        xi_ids = {p["id"] for p in team["xi"]}

        def head(text):
            lb.insert("end", text)
            lb.itemconfig("end", foreground=GOLD)
            idmap.append(None)

        head(f"  {team['name']} — Likely XI")
        for p in team["xi"]:
            lb.insert("end", f"   {p['name']}")
            idmap.append((p["id"], p["name"]))
        head("  Bench / squad")
        for p in team["squad"]:
            if p["id"] not in xi_ids:
                lb.insert("end", f"   {p['name']}")
                idmap.append((p["id"], p["name"]))

    def _pick(self, lb, idmap, ev):
        i = lb.nearest(ev.y)
        if 0 <= i < len(idmap) and idmap[i]:
            self.load_player(*idmap[i])

    # ----- automated recommendations -----
    def find_value(self):
        home, away = self.e_home.get().strip(), self.e_away.get().strip()
        if not home or not away:
            return
        n = self.e_n.get().strip() or "18"
        self._last = (home, away, n)
        via = " (predicted lineup)" if self._match else ""
        self._status(f"scanning {home} vs {away}{via} — every starter × market (first run 1–2 min)…")
        self._recommend(use_odds=False, fresh=True)

    def _recommend(self, use_odds, fresh=False):
        if not self._last:
            return
        home, away, n = self._last
        q = urllib.parse.quote
        url = f"/api/recommend?home={q(home)}&away={q(away)}&lastN={q(n)}"
        if self._match and self._match.get("matchId"):
            m = self._match
            url += f"&matchId={m['matchId']}"
            if m.get("homeId"):
                url += f"&homeId={m['homeId']}"
            if m.get("awayId"):
                url += f"&awayId={m['awayId']}"
        if use_odds:
            url += "&useOdds=1"
        if fresh:
            url += "&fresh=1"
        self._async(lambda: api(url), self._render_recos)

    # ----- fixture picker -----
    def open_fixtures(self):
        self._status("loading upcoming fixtures…")

        def work():
            today = datetime.date.today()
            out = []
            for i in range(3):  # today + next 2 days
                ds = (today + datetime.timedelta(days=i)).isoformat()
                try:
                    for f in api(f"/api/fixtures?date={ds}"):
                        if not f.get("finished"):
                            f["date"] = ds
                            out.append(f)
                except Exception:
                    pass
            return out

        self._async(work, self._show_fixtures)

    def _show_fixtures(self, fixtures):
        if not fixtures:
            return self._status("no upcoming fixtures found in popular leagues", err=True)
        self._status(f"{len(fixtures)} upcoming fixtures — double-click one to scan")
        top = tk.Toplevel(self.root)
        top.title("Upcoming fixtures — double-click to scan")
        top.geometry("580x540")
        tv = ttk.Treeview(top, columns=("league",), show="tree headings")
        tv.heading("#0", text="Fixture")
        tv.column("#0", width=380, anchor="w")
        tv.heading("league", text="League")
        tv.column("league", width=180, anchor="w")
        sb = ttk.Scrollbar(top, command=tv.yview)
        tv.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        tv.pack(side="left", fill="both", expand=True)
        tv.tag_configure("hdr", foreground=GOLD)
        rowmap, last_date, hdr = {}, None, ""
        for f in sorted(fixtures, key=lambda x: (x["date"], x.get("utc") or "")):
            if f["date"] != last_date:
                last_date = f["date"]
                hdr = tv.insert("", "end", text=f["date"], open=True, tags=("hdr",))
            ko = (f.get("utc") or "")[11:16]
            iid = tv.insert(hdr, "end", text=f"  {ko}  {f['home']} v {f['away']}", values=(f.get("league", ""),))
            rowmap[iid] = f

        def pick(ev):
            f = rowmap.get(tv.identify_row(ev.y))
            if not f:
                return
            self._match = {"matchId": f["matchId"], "home": f["home"], "away": f["away"],
                           "homeId": f.get("homeId"), "awayId": f.get("awayId")}
            for entry, val in ((self.e_home, f["home"]), (self.e_away, f["away"])):
                entry.delete(0, "end")
                entry.insert(0, val)
            top.destroy()
            self.find_value()

        tv.bind("<Double-Button-1>", pick)

    @staticmethod
    def _leg_label(l):
        base = l["market"] if l["kind"] == "atleast" else f"{l['market']} o{l['line']}"
        return f"{l['player']} — {base}"

    def _leg_vals(self, l, od):
        ev = f"{l['edge'] * 100:+.1f}pp" if od and l.get("edge") is not None else ""
        return (f"{round(l['p'] * 100)}%", f"{l['odds']:.2f}" if l.get("odds") else "—", "", ev)

    def _render_recos(self, rec):
        if "error" in rec:
            return self._status(rec["error"], err=True)
        od = rec["haveOdds"]
        t = self.reco
        t.delete(*t.get_children())
        self._reco_leg.clear()
        self.nb.select(0)

        status = rec.get("lineupStatus") or "heuristic"
        badge = {
            "confirmed": ("✓ CONFIRMED LINEUP — these players are starting", "pos"),
            "predicted": ("◑ PREDICTED XI — not confirmed yet; re-run Find value near kickoff", "hdr"),
            "heuristic": ("⚠ ESTIMATED from recent starters — no lineup released, players may not start", "neg"),
        }.get(status, (f"lineup: {status}", "hdr"))
        t.insert("", "end", text=badge[0], tags=(badge[1],))
        warn = rec["meta"].get("oddsWarning")
        if warn:
            t.insert("", "end", text=f"⚠ ODDS MISMATCH — {warn}", tags=("neg",))

        h = t.insert("", "end", text="TOP SINGLE LEGS  ·  by " + ("edge" if od else "confidence"), tags=("hdr",))
        for l in rec["topLegs"]:
            tag = "pos" if od and (l.get("edge") or 0) > 0 else ""
            iid = t.insert(h, "end", text="   " + self._leg_label(l) + f"   (n{l['sample']})",
                           values=self._leg_vals(l, od), tags=(tag,))
            self._reco_leg[iid] = (l.get("playerId"), l["player"])

        order = []
        if od:
            order.append(("VALUE  ·  small +EV combos", "value"))
        order.append(("ACCUMULATOR  ·  most likely small combo", "bankers"))
        order.append(("PARLAYS  ·  big multis — place on BETFAIR (no 1000/1 cap)", "parlays"))
        for title, key in order:
            tiers = rec["tiers"].get(key, [])
            hh = t.insert("", "end", text=f"{title}   ({len(tiers)})", tags=("hdr",))
            for p in tiers:
                o = p.get("odds")
                if o:
                    odds = (f"{o:.2f}" if o < 100 else f"{o:.0f}") + (" →BF" if p.get("betfair") else "")
                else:
                    odds = f"{p['fairOdds']:.1f} fair"
                ret = f"~€{p['ret10']:.0f}" if p.get("ret10") else "—"   # ~ = independent estimate; bet365 quotes less
                ev = f"{p['ev']:+.2f}" if p.get("ev") is not None else ""
                tag = "pos" if (p.get("ev") or 0) > 0 else ""
                par = t.insert(hh, "end", text=f"   {p['size']}-leg parlay",
                               values=(f"{round(p['prob'] * 100)}%", odds, ret, ev), tags=(tag,))
                for l in p["legs"]:
                    iid = t.insert(par, "end", text="        " + self._leg_label(l), values=self._leg_vals(l, od))
                    self._reco_leg[iid] = (l.get("playerId"), l["player"])

        m = rec["meta"]
        tail = "odds merged ✓" if od else "Capture bet365 to add odds + returns"
        self._status(f"{rec['fixture']} — {m['legsScored']} legs scored, {m['parlaysBuilt']} parlays  ·  {tail}")

    def _reco_click(self, ev):
        # double-click a leg → open that player's full hit-rate grid (the stats behind the pick)
        info = self._reco_leg.get(self.reco.identify_row(ev.y))
        if info and info[0]:
            self.load_player(info[0], info[1])

    # ----- player deep dive -----
    def load_player(self, pid, name):
        if pid in self.tabs:
            self.nb.select(self.tabs[pid].master)
            return
        self._status(f"loading {name}…")
        n = self.e_n.get().strip() or "10"
        self._async(lambda: api(f"/api/deepdive?id={pid}&lastN={urllib.parse.quote(n)}"),
                    lambda dd: self._add_tab(pid, name, dd))

    def _add_tab(self, pid, name, dd):
        if "error" in dd:
            return self._status(f"{name}: {dd['error']}", err=True)
        frame = ttk.Frame(self.nb)
        tree = ttk.Treeview(frame, columns=self.COLS, show="tree headings", height=24)
        tree.heading("#0", text="Market / line")
        tree.column("#0", width=150, anchor="w")
        for c, h in zip(self.COLS, self.HEADS):
            tree.heading(c, text=h)
            tree.column(c, width=66, anchor="center")
        sb = ttk.Scrollbar(frame, command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        tree.pack(side="left", fill="both", expand=True)
        tree.tag_configure("mkt", foreground=GOLD)
        tree.tag_configure("pos", foreground=GREEN)
        tree.tag_configure("neg", foreground=RED)
        tree.hr = {}      # row iid -> hitRate dict
        tree.rowkey = {}  # row iid -> (marketKey, line)  — line is None for anytime markets
        tree.pname = name

        for key, m in dd["markets"].items():
            parent = tree.insert("", "end", text=m["label"], open=True, tags=("mkt",))
            anytime = m["kind"] == "atleast"
            for ln in m["lines"]:
                label = "Anytime" if anytime else f"o {ln['line']}"
                hr = ln["hitRate"]
                iid = tree.insert(parent, "end", text=label, values=(
                    pct(hr["last10"], True), pct(hr["last5"]), pct(hr["season"]),
                    pct(hr["home"]), pct(hr["away"]), "", "", "", ""))
                tree.hr[iid] = hr
                tree.rowkey[iid] = (key, None if anytime else ln["line"])

        tree.bind("<Double-Button-1>", self._edit_odds)
        self.tabs[pid] = tree
        label = f"{name}  ({dd['sample']})"
        self.nb.add(frame, text=label)
        self.nb.select(frame)
        self._status(f"{name} — last {dd['sample']} games loaded")

    def _edit_odds(self, ev):
        tree = ev.widget
        if tree.identify_region(ev.x, ev.y) != "cell":
            return
        if tree.identify_column(ev.x) != "#6":  # Odds is the 6th data column
            return
        iid = tree.identify_row(ev.y)
        if not iid or iid not in tree.hr:
            return
        x, y, w, h = tree.bbox(iid, "#6")
        ent = ttk.Entry(tree)
        ent.place(x=x, y=y, width=w, height=h)
        ent.insert(0, tree.set(iid, "odds"))
        ent.select_range(0, "end")
        ent.focus_set()

        def commit(_=None):
            raw = ent.get()
            ent.destroy()
            shown, imp, edge, fair, pos = edge_row(tree.hr[iid], raw)
            tree.set(iid, "odds", shown)
            tree.set(iid, "imp", imp)
            tree.set(iid, "edge", edge)
            tree.set(iid, "fair", fair)
            tree.item(iid, tags=() if pos is None else ("pos" if pos else "neg",))

        ent.bind("<Return>", commit)
        ent.bind("<FocusOut>", commit)
        ent.bind("<Escape>", lambda _e: ent.destroy())

    # ----- bet365 attended capture -----
    def capture_bet365(self):
        if not self._last and not self.tabs:
            return self._status("run Find value (or scan a player) first, then Capture", err=True)
        self._status("opening Edge on bet365 — sign in there (real browser, login works), open the "
                     "fixture's Bet Builder, then click the gold CAPTURE ODDS button…")

        def work():
            with open(os.path.join(HERE, "_b365_capture.log"), "w", encoding="utf-8") as lf:
                subprocess.run([NODE, "capture-bet365.mjs"], cwd=HERE, stdout=lf, stderr=lf)
            path = os.path.join(HERE, "_b365_capture.json")
            if not os.path.exists(path):
                raise RuntimeError("capture produced no file")
            with open(path, encoding="utf-8") as f:
                return json.load(f)

        self._async(work, self._apply_capture)

    def _apply_capture(self, data):
        if not data.get("ok"):
            return self._status(f"bet365 capture: {data.get('reason', 'failed')}", err=True)
        rows = data.get("rows", [])
        filled = unmatched = 0
        for r in rows:
            tree = self._match_player(r["player"])
            if not tree:
                unmatched += 1
                continue
            iid = self._match_row(tree, r["marketKey"], r.get("line"))
            if iid is None:
                continue
            shown, imp, edge, fair, pos = edge_row(tree.hr[iid], r["odds"])
            tree.set(iid, "odds", shown)
            tree.set(iid, "imp", imp)
            tree.set(iid, "edge", edge)
            tree.set(iid, "fair", fair)
            tree.item(iid, tags=() if pos is None else ("pos" if pos else "neg",))
            filled += 1
        grid = f", filled {filled} grid cells" if self.tabs else ""
        self._status(f"bet365: captured {len(rows)} prices{grid} — re-ranking parlays with odds…")
        if self._last:
            self._recommend(use_odds=True)  # server re-reads _b365_capture.json, merges, re-ranks

    def _match_player(self, name):
        for tree in self.tabs.values():
            if name_match(name, tree.pname):
                return tree
        return None

    @staticmethod
    def _match_row(tree, mk, line):
        for iid, (k, ln) in tree.rowkey.items():
            if k != mk:
                continue
            if ln is None and line is None:
                return iid
            if ln is not None and line is not None and abs(ln - line) < 0.01:
                return iid
        return None

    def on_close(self):
        if self.server and self.owns_server:
            self.server.terminate()
        self.root.destroy()


def _selftest():
    assert to_decimal("1.83") == 1.83
    assert to_decimal("5/6") == 5 / 6 + 1
    assert to_decimal("evens") == 2.0
    assert to_decimal("0.5") is None and to_decimal("") is None and to_decimal("x") is None
    hr = {"last10": {"rate": 0.70, "n": 10}, "season": {"rate": 0.6, "n": 30}}
    shown, imp, edge, fair, pos = edge_row(hr, "1.5")  # implied 66.7%, base 70%
    assert imp == "66.7%" and edge == "+3.3pp" and fair == "1.43" and pos is True, (imp, edge, fair)
    # empty L10 falls back to season; negative edge
    hr2 = {"last10": {"rate": None, "n": 0}, "season": {"rate": 0.40, "n": 20}}
    _, _, edge2, _, pos2 = edge_row(hr2, "2.0")  # implied 50%, base 40% -> -10pp
    assert edge2 == "-10.0pp" and pos2 is False, edge2
    print("OK — odds parse + edge math correct.")


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    _selftest() if "--selftest" in sys.argv else main()
