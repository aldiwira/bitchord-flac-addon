import { parseTier, NotFound } from '../lib/http.js';
import { resolve } from '../lib/resolve.js';
import { MEDIA_RETRIES, PROXY_AUDIO, SEARCH_TIMEOUT_MS } from '../config.js';
import { json, notFound, log } from '../utils/response.js';
const { delay } = await import('node:timers/promises');

const CONTENT_TYPES = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
};

export function idFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function handleMedia(req, res, url) {
  if (!PROXY_AUDIO) {
    return json(res, 404, {
      error: 'PROXY_DISABLED',
      message: 'audio is not proxied by this host (PROXY=0)',
    });
  }

  const id = idFromPath(url.pathname, '/media/')
    .replace(/\.(flac|mp3|aac|m4a|opus|ogg)$/i, '');

  let resolved;
  try {
    // Same budget as `/stream`, because this is the same resolution and may be
    // the same failover walk; a proxy fetch gets its own deadline below.
    resolved = await resolve(
      id,
      parseTier(url.searchParams.get('quality')),
      AbortSignal.timeout(SEARCH_TIMEOUT_MS * 2),
    );
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: error.message });
  }

  const codec = String(resolved.result.codec ?? 'flac').toLowerCase();

  const rangeHeader = req.headers.range;
  const clientWantsStart =
    !rangeHeader || /^\s*bytes\s*=\s*0-/i.test(rangeHeader);

  let upstream = null;
  for (let attempt = 0; attempt <= MEDIA_RETRIES; attempt++) {
    if (attempt > 0) await delay(250 * attempt);
    try {
      const candidate = await fetch(resolved.result.url, {
        headers: {
          'User-Agent': 'BitChord-FLAC-Addon/1.0',
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
      });
      if (candidate.ok) {
        upstream = candidate;
        break;
      }
      candidate.body?.cancel?.().catch(() => {});
      if (candidate.status < 500) {
        return json(res, 502, {
          error: 'UPSTREAM_REJECTED',
          message: `the source answered HTTP ${candidate.status}`,
        });
      }
    } catch {
      /* fall through to the retry */
    }
  }

  if (!upstream) {
    return json(res, 502, {
      error: 'UPSTREAM_UNAVAILABLE',
      message: 'the source did not return the audio',
    });
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  if (!upstream.body) {
    headers['Content-Length'] = '0';
    return res.writeHead(204, headers).end();
  }

  let first = Buffer.alloc(0);
  const reader = upstream.body.getReader();
  if (clientWantsStart && codec === 'flac') {
    const chunk = await reader.read();
    first = chunk.value ? Buffer.from(chunk.value) : Buffer.alloc(0);
    if (first.subarray(0, 4).toString('ascii') !== 'fLaC') {
      reader.cancel().catch(() => {});
      return json(res, 502, {
        error: 'NOT_FLAC',
        message: 'the source served something that is not a FLAC file',
      });
    }
  }

  headers['Content-Type'] = CONTENT_TYPES[codec] ?? 'application/octet-stream';
  res.writeHead(upstream.status, headers);

  try {
    if (first.length) res.write(first);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (error) {
    log('info', 'media transfer ended early', { id, error: error.message });
    res.destroy();
  }
}
