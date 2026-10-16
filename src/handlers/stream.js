import { parseTier, NotFound, UpstreamError } from '../lib/http.js';
import { parseTrackId } from '../lib/trackid.js';
import { archive, parseArchiveId } from '../lib/sources/archive.js';
import { REGISTRY } from '../registry.js';
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

/**
 * Resolves one row id to something playable.
 */
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

export function describeQuality(answer) {
  if (answer.sampleRate && answer.bitDepth) {
    const hires = answer.sampleRate > 48000 || answer.bitDepth > 16;
    return `${hires ? 'Hi-Res' : 'Lossless'} FLAC · ${answer.bitDepth}-bit / ${
      (answer.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
    } kHz`;
  }
  return 'Lossless FLAC · bit depth read from the FLAC header';
}

export async function handleStream(req, res, url) {
  const id = idFromPath(url.pathname, '/stream/');
  if (!id) return notFound(res, 'no track id in path');

  const tier = parseTier(url.searchParams.get('quality'));
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

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
  const proxied = PROXY_AUDIO;
  const url_ = proxied
    ? `${publicOrigin(req)}/media/${encodeURIComponent(id)}.flac` +
      (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '')
    : answer.url;

  log('info', 'stream', {
    id,
    tier,
    source: resolved.source,
    proxied,
    probed: answer.probed,
    sampleRate: answer.sampleRate,
    bitDepth: answer.bitDepth,
  });

  return json(res, 200, {
    url: url_,
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
