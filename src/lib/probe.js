/**
 * Reading what a media URL actually serves.
 *
 * Every source here hands back bytes it does not describe: an extensionless
 * `application/octet-stream`, a signed CDN URL, a FLAC file behind a redirect.
 * None of them advertise a sample rate, and the ones that do are quoting their
 * catalogue rather than the file. BitChord settles lossless claims against what
 * the device decodes, so the honest answer has to be read from the bytes.
 *
 * One function, because the sources were each growing their own copy of this
 * and drifting: the `Content-Range` handling and the "do not cache a failed
 * probe" rule are exactly the things a second copy gets wrong.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from './flac.js';
import { httpGet, TtlCache } from './http.js';

/**
 * A property of a file, not of a request: STREAMINFO cannot change for a given
 * recording, and a source's media URL is stable. Cached for the life of the
 * process, so a restart is the only thing that re-reads it.
 */
const probeCache = new TtlCache(5_000);

/**
 * The media answer for a file that is not FLAC.
 *
 * A catalogue that serves MP3 for a lossless request is not a failure, and
 * refusing it would cost a track that plays. It is simply not lossless, so the
 * fields that would be a claim are absent and the codec says what arrived.
 */
export function lossyAnswer(url, codec) {
  return {
    url,
    codec,
    container: codec,
    manifest: 'none',
    encrypted: false,
    sampleRate: null,
    bitDepth: null,
    bitrate: null,
    channels: null,
    probed: false,
  };
}

/**
 * Probes `url` and describes it, or returns null when it does not serve FLAC.
 *
 * Returning null rather than throwing is deliberate: a URL that is not FLAC is a
 * fact the caller acts on (label it as what it is, or move on), not an error to
 * be caught. A probe that *fails* — timeout, reset — is also null, and is
 * deliberately not cached, so a transient failure is retried rather than
 * stripping the track of its bit depth for the life of the process.
 *
 * @param {string} url
 * @param {{cacheKey?: string, signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{url: string, codec: 'flac', container: 'flac', manifest: 'none',
 *            encrypted: false, sampleRate: number, bitDepth: number,
 *            bitrate: number|null, channels: number, durationSec: number,
 *            probed: true, error?: string}|null>}
 */
export async function probeFlac(url, { cacheKey = url, signal, timeoutMs = 12_000 } = {}) {
  return probeCache.wrap(`probe:${cacheKey}`, Number.MAX_SAFE_INTEGER, async () => {
    let response;
    try {
      response = await httpGet(url, {
        timeoutMs,
        // One retry: a single reset on a 42-byte range request is the common
        // failure and a second ask usually succeeds.
        retries: 1,
        range: `bytes=0-${STREAMINFO_BYTES - 1}`,
        signal,
      });
    } catch (error) {
      // A rate limit is not a fact about the file, and caching it as one would
      // strip the track of its bit depth for the life of the process. Reported
      // to the caller so it can treat it as the transient thing it is.
      if (error?.status === 429) throw error;
      return null;
    }

    let head;
    try {
      head = Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }

    const info = parseFlacStreamInfo(head);
    if (!info) return null;

    // `Content-Range: bytes 0-41/43704112` is the only place the byte count is
    // published. Without it the bitrate is genuinely unknown rather than merely
    // unstated, and is left absent rather than guessed.
    const contentRange = response.headers.get('content-range') ?? '';
    const slash = contentRange.lastIndexOf('/');
    const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;
    const byteLength = Number.isFinite(total) && total > 0 ? total : null;

    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: info.sampleRate,
      bitDepth: info.bitDepth,
      bitrate: byteLength ? flacKbps(byteLength, info.durationSec) : null,
      channels: info.channels,
      durationSec: info.durationSec,
      probed: true,
    };
  });
}

/**
 * Describes a URL, falling back to naming what arrived when it is not FLAC.
 *
 * The shape `probeFlac` returns is already the addon's stream answer; this adds
 * the one other outcome a catalogue can have, which is serving something lossy
 * where lossless was asked for.
 *
 * @param {string} url
 * @param {{codec?: string, cacheKey?: string, signal?: AbortSignal}} [opts]
 */
export async function describeMedia(url, { codec, cacheKey, signal } = {}) {
  const probed = await probeFlac(url, { cacheKey, signal });
  if (probed) return probed;
  if (codec) return lossyAnswer(url, codec);
  return null;
}
