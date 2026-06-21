// Local API + static server. No framework — node:http serves two JSON endpoints + the UI.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveFixture, getTeam, likelyXI, listFixtures, close } from './src/fotmob.js';
import { deepDive } from './src/scan.js';
import { legsForFixture, recommend } from './src/scanner.js';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
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

    // Upcoming fixtures for a date (YYYY-MM-DD) — the picker.
    if (url.pathname === '/api/fixtures') {
      const date = q.get('date') || new Date().toISOString().slice(0, 10);
      return json(res, 200, await listFixtures(date));
    }

    // Automated value scan → ranked legs + tiered parlays. useOdds=1 merges the last bet365 capture.
    if (url.pathname === '/api/recommend') {
      const num = (k) => (q.get(k) ? Number(q.get(k)) : null);
      let data;
      try {
        data = await legsForFixture(
          { matchId: num('matchId'), home: q.get('home') || '', away: q.get('away') || '', homeId: num('homeId'), awayId: num('awayId'), fresh: !!q.get('fresh') },
          Number(q.get('lastN')) || 18);
      } catch (e) { return json(res, 404, { error: String(e?.message || e) }); }
      let oddsRows = null;
      if (q.get('useOdds')) {
        try { oddsRows = JSON.parse(await readFile(CAPTURE, 'utf8')).rows; } catch { /* no capture yet */ }
      }
      return json(res, 200, recommend(data, oddsRows));
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
