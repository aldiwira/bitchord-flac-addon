import { parseTier, NotFound, UpstreamError } from '../../lib/http.js';
import { parseTrackId } from '../../lib/trackid.js';
import { archive, parseArchiveId } from '../../lib/sources/archive.js';
import { REGISTRY } from '../registry.js';
import { SEARCH_TIMEOUT_MS, PROXY_AUDIO, TOKEN } from '../config.js';
import { json, notFound, log, publicOrigin } from '../utils/response.js';
const { delay } = await import('node:timers/promises');

const MEDIA_RETRIES = 3;

export function idFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function resolve(id, tier, signal) {
  const parsed = parseTrackId(id);
  if (!parsed) throw new NotFound('not an id this addon issued');

  const source = REGISTRY.get(parsed.source);
  if (!source) throw new NotFound(`unknown source "${parsed.source}"`);

  if (source === archive) {
    const parts = parseArchiveId(id);
    if (!parts) throw new NotFound('malformed archive id');
    return { source: source.id, result: await source.resolve(parts.filename, tier, parts, signal) };
  }
  return { source: source.id, result: await source.resolve(parsed.nativeId, tier, signal) };
}

export async function handleMedia(req, res, url) {
  const id = idFromPath(url.pathname, '/media/').replace(/\.flac$/i, '');

  let resolved;
  try {
    resolved = await resolve(id, parseTier(url.searchParams.get('quality')));
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: error.message });
  }

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
  if (clientWantsStart) {
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

  headers['Content-Type'] = 'audio/flac';
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
