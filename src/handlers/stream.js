import { parseTier, NotFound, UpstreamError } from '../lib/http.js';
import { resolve } from '../lib/resolve.js';
import { SEARCH_TIMEOUT_MS, PROXY_AUDIO, TOKEN } from '../config.js';
import { json, notFound, log, publicOrigin } from '../utils/response.js';

/**
 * Reads one track id out of a request path.
 */
export function idFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function describeQuality(answer) {
  const codec = String(answer.codec ?? 'flac').toUpperCase();

  if (answer.sampleRate && answer.bitDepth) {
    const hires = answer.sampleRate > 48000 || answer.bitDepth > 16;
    return `${hires ? 'Hi-Res' : 'Lossless'} ${codec} · ${answer.bitDepth}-bit / ${
      (answer.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
    } kHz`;
  }

  if (codec === 'FLAC') {
    return 'Lossless FLAC · bit depth read from the FLAC header';
  }

  const kbps = answer.bitrate ? ` · ${answer.bitrate} kbps` : '';
  return `${codec}${kbps}`;
}

export async function handleStream(req, res, url) {
  const id = idFromPath(url.pathname, '/stream/');
  if (!id) return notFound(res, 'no track id in path');

  const tier = parseTier(url.searchParams.get('quality'));
  // A failover walk can outlast a single search: it searches the other
  // catalogues, then resolves against one of them. Twice the search budget
  // covers that and is still inside the window BitChord keeps open.
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS * 2);

  let resolved;
  try {
    resolved = await resolve(id, tier, deadline);
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    if (error instanceof UpstreamError) {
      log('warn', 'stream upstream failure', { id, status: error.status, error: error.message });
      return json(res, 502, {
        error: 'UPSTREAM_UNAVAILABLE',
        message: error.message,
      });
    }
    throw error;
  }

  const answer = resolved.result;
  const extension = String(answer.container ?? answer.codec ?? 'flac').toLowerCase();

  // The proxy route takes the id BitChord sent, not the id that was resolved. It
  // re-runs this same resolution, so a stream URL that moves to another
  // catalogue is re-derived there rather than pinned to one that has expired by
  // the time the player asks for the bytes.
  const playableUrl = PROXY_AUDIO
    ? `${publicOrigin(req)}/media/${encodeURIComponent(id)}.${extension}` +
      (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '')
    : answer.url;

  log('info', 'stream', {
    id,
    tier,
    source: resolved.source,
    // Only when the issuing catalogue could not serve its own row: names the
    // catalogue that did, so a failover is visible in the log rather than
    // looking like the row was served by the source it came from.
    moved: resolved.source !== resolved.issuer ? resolved.issuer : undefined,
    sampleRate: answer.sampleRate,
    bitDepth: answer.bitDepth,
    proxied: PROXY_AUDIO,
    ip: req.socket.remoteAddress
  });

  return json(res, 200, {
    url: playableUrl,
    codec: answer.codec,
    container: answer.container,
    manifest: answer.manifest,
    encrypted: answer.encrypted,
    sampleRate: answer.sampleRate ?? undefined,
    bitDepth: answer.bitDepth ?? undefined,
    bitrate: answer.bitrate ?? undefined,
    quality: describeQuality(answer),
  });
}
