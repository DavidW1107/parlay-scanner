// Local API + static server. No framework — node:http serves two JSON endpoints + the UI.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveFixture, getTeam, likelyXI, listFixtures, close } from './src/fotmob.js';
import { deepDive, legStat } from './src/scan.js';
import { legsForFixture, recommend } from './src/scanner.js';
import { spawn } from 'node:child_process';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CAPTURE = fileURLToPath(new URL('./_b365_capture.json', import.meta.url));
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js' }; // whitelist → no path traversal
const PORT = Number(process.env.PORT) || 5757;

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;

    if (url.pathname === '/api/fixture') {
      const { home, away } = await resolveFixture(q.get('home') || '', q.get('away') || '');
      if (!home || !away) return json(res, 404, { error: 'team not found — check spelling' });
      const [hp, ap] = await Promise.all([getTeam(home.id), getTeam(away.id)]); // squads (cached for likelyXI)
      const [hx, ax] = await Promise.all([likelyXI(home.id), likelyXI(away.id)]);
      return json(res, 200, {
        home: { id: home.id, name: home.name, xi: hx, squad: hp.players },
        away: { id: away.id, name: away.name, xi: ax, squad: ap.players },
      });
    }

    if (url.pathname === '/api/deepdive') {
      const id = Number(q.get('id'));
      if (!id) return json(res, 400, { error: 'id required' });
      return json(res, 200, await deepDive(id, Number(q.get('lastN')) || 10));
    }

    // Focused stats for one leg (hit-rate windows + per-90 + game log) — the drill-down.
    if (url.pathname === '/api/legstat') {
      const id = Number(q.get('id'));
      if (!id) return json(res, 400, { error: 'id required' });
      return json(res, 200, await legStat(id, q.get('market'), q.get('line') ?? '', Number(q.get('lastN')) || 18));
    }

    // Both squads by team id — feeds the XI editor (getTeam is cached, so this is instant post-scan).
    if (url.pathname === '/api/squads') {
      const hId = Number(q.get('homeId')), aId = Number(q.get('awayId'));
      if (!hId || !aId) return json(res, 400, { error: 'homeId and awayId required' });
      const [h, a] = await Promise.all([getTeam(hId), getTeam(aId)]);
      return json(res, 200, { home: h.players, away: a.players });
    }

    // Upcoming fixtures for a date (YYYY-MM-DD) — the picker.
    if (url.pathname === '/api/fixtures') {
      const date = q.get('date') || new Date().toISOString().slice(0, 10);
      return json(res, 200, await listFixtures(date));
    }

    // Automated value scan → ranked legs + tiered parlays. useOdds=1 merges the last bet365 capture.
    if (url.pathname === '/api/recommend') {
      const num = (k) => (q.get(k) ? Number(q.get(k)) : null);
      const ids = (k) => (q.get(k) ? q.get(k).split(',').map(Number).filter(Boolean) : null); // user-adjusted XI
      let data;
      try {
        data = await legsForFixture(
          { matchId: num('matchId'), home: q.get('home') || '', away: q.get('away') || '', homeId: num('homeId'), awayId: num('awayId'), utc: q.get('utc') || null, fresh: !!q.get('fresh'), homeXI: ids('homeXI'), awayXI: ids('awayXI') },
          Number(q.get('lastN')) || 18);
      } catch (e) { return json(res, 404, { error: String(e?.message || e) }); }
      let oddsRows = null;
      if (q.get('useOdds')) {
        try { oddsRows = JSON.parse(await readFile(CAPTURE, 'utf8')).rows; } catch { /* no capture yet */ }
      }
      return json(res, 200, recommend(data, oddsRows));
    }

    // Attended bet365 capture — spawns capture-bet365.mjs (opens a real browser you drive), waits for
    // it to finish, returns the merged result. POST only so a stray GET can't launch a browser.
    if (url.pathname === '/api/capture') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      await new Promise((resolve) => {
        const p = spawn(process.execPath, ['capture-bet365.mjs'], { cwd: HERE, stdio: 'ignore' });
        p.on('close', resolve);
        p.on('error', resolve); // capture-bet365.mjs always writes its own result file; read it below
      });
      try { return json(res, 200, JSON.parse(await readFile(CAPTURE, 'utf8'))); }
      catch { return json(res, 200, { ok: false, reason: 'capture produced no file', rows: [] }); }
    }

    const file = STATIC[url.pathname];
    if (!file) return json(res, 404, { error: 'not found' });
    const body = await readFile(WEB + file);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(body);
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});
server.listen(PORT, () => console.log(`\nparlay-scanner → http://localhost:${PORT}\n`));
process.on('SIGINT', async () => { await close(); process.exit(0); });
