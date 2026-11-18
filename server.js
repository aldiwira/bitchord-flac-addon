/**
 * A BitChord addon server for true FLAC.
 *
 * BitChord's addon protocol is three GET routes returning JSON, and that is the
 * whole of what this process implements. No code is downloaded by the app and
 * none is executed there; it asks this server what it holds, and plays the URL
 * this server names.
 *
 *   GET /manifest.json        what this addon is and what it can do
 *   GET /search               the catalogue, for one query
 *   GET /stream/{id}          one playable rendition of one track
 *   GET /media/{id}.flac      optional; see PROXY below
 *   GET /health               for humans, not for BitChord
 *
 * Environment:
 *   PORT           listen port                        (default 8787)
 *   HOST           bind address                       (default 0.0.0.0)
 *   SOURCES        comma-separated source list        (default tidal,archive)
 *   PROXY          '1' to serve audio through here    (default 0)
 *   ADDON_TOKEN    if set, required as ?token= on every route
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PORT, HOST, TOKEN, AUTH_MODE, AUTH_HOSTS } from './src/config.js';
import { MANIFEST } from './src/manifest.js';
import { createAuth, parseHosts } from './src/lib/auth.js';
import { tokenOk, json, log } from './src/utils/response.js';
import { handleSearch } from './src/handlers/search.js';
import { handleStream } from './src/handlers/stream.js';
import { handleMedia } from './src/handlers/media.js';
import { handleHealth } from './src/handlers/health.js';

/**
 * Runs the BitChord check for one route.
 *
 * Returns false when the request was refused and the response is already sent.
 * `log` mode declares the flag, verifies, and then serves anyway — the rollout
 * step in the docs, where `invalid_proof` is watched before anyone is turned
 * away.
 *
 * @returns {Promise<boolean>}
 */
async function allowed(req, res, path) {
  if (auth.mode === 'off') return true;

  const outcome = await auth.check(req);
  if (outcome.ok) return true;

  if (auth.mode === 'log') {
    log('warn', 'bitchord auth would refuse', { path, code: outcome.error ?? 'unknown' });
    return true;
  }

  res.writeHead(outcome.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(outcome.body),
    'Cache-Control': 'no-store',
    ...outcome.headers,
  });
  res.end(outcome.body);
  log('info', 'bitchord auth refused', { path, code: outcome.error });
  return false;
}

/**
 * BitChord addon auth, built once at startup.
 *
 * `enforce` without a host list is a startup failure rather than a warning: the
 * proof signs the hostname the listener pasted, so enforcing with an empty list
 * refuses every request while `/health` still looks fine.
 */
const auth = createAuth({ mode: AUTH_MODE, hosts: parseHosts(AUTH_HOSTS) });

const server = createServer(async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();

  res.setHeader('X-Request-Id', requestId);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      });
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'every route is a GET' });
    }

    if (!tokenOk(url.searchParams.get('token'), TOKEN) && url.pathname !== '/health') {
      return json(res, 401, { error: 'UNAUTHORIZED', message: 'a ?token= is required' });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/manifest.json' || path === '/manifest') {
      return json(res, 200, MANIFEST);
    }

    if (path === '/search') {
      if (!(await allowed(req, res, path))) return;
      return await handleSearch(req, res, url);
    }

    if (path.startsWith('/stream/') || path.startsWith('/media/')) {
      // `/media` is checked even though the player fetches it without the
      // BitChord headers: when PROXY=1 the URL is minted per request and is the
      // only thing standing between the audio and the open internet, so it is
      // gated here and the `?token=` check above still applies. `PROXY=0` hands
      // out the upstream URL and never reaches this route.
      if (!(await allowed(req, res, path))) return;
      return path.startsWith('/stream/')
        ? await handleStream(req, res, url)
        : await handleMedia(req, res, url);
    }

    if (path === '/' || path === '/health') {
      return await handleHealth(req, res);
    }

    return json(res, 404, {
      error: 'NOT_FOUND',
      message: 'see GET /health for the routes this addon serves',
    });
  } catch (error) {
    log('error', 'unhandled', { requestId, path: url.pathname, error: error.stack ?? error.message });
    if (!res.headersSent) {
      return json(res, 500, { error: 'INTERNAL', message: error.message, requestId });
    }
    res.destroy();
  } finally {
    if (!res.headersSent) return;
    log('info', 'request', {
      requestId,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Date.now() - started,
      ip: req.socket.remoteAddress
    });
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  const host = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  log('info', 'listening', {
    url: host,
    proxyAudio: process.env.PROXY === '1',
    tokenRequired: Boolean(TOKEN),
  });
  console.log('');
  console.log(`  Add to BitChord:  ${host}/manifest.json`);
  console.log(`  Health check:     ${host}/health`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

export { server, MANIFEST };
