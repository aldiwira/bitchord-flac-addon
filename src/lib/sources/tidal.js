/**
 * Tidal, through Monochrome's public catalogue API.
 *
 * This is the source that makes the addon worth deploying. It needs no account,
 * no token and no developer credentials — `tracks.monochrome.st` is a public
 * read-only index, and the audio it serves is genuine FLAC.
 *
 * Two shapes, and the difference matters:
 *
 *   GET /search/tracks?q=…&limit=N  → metadata, JSON, fast
 *   GET /track/{id}                 → the FLAC bytes themselves
 *
 * So there is no URL-resolution step. There is no signature to obtain, nothing
 * that expires between the `/search` and the `/stream` call, and no second
 * round trip on the path that has to finish before audio starts — which is the
 * one thing the other candidate sources all got wrong.
 *
 * What it does not do is describe itself. The response is
 * `application/octet-stream` with no extension and nothing about the audio
 * inside, so `probe.js` reads the FLAC header to answer for it.
 *
 * ## Relationship to the Monochrome source
 *
 * Both read `tracks.monochrome.st`, and that is not a duplicate: this one asks
 * the canonical index directly and accepts only what it can resolve
 * progressively, while `monochrome` also walks the public instances and knows
 * about DASH and previews. This source is the fast, predictable half; that one is
 * the thorough half. When the index is up they agree, and when it is down this
 * one reports so through `/health` rather than failing silently.
 */

import { probeFlac } from '../probe.js';
import { httpJson, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = (process.env.TIDAL_BASE_URL || 'https://tracks.monochrome.st').replace(/\/+$/, '');

/** Search rows change; keep them briefly so a queue re-ask is free. */
const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

const MAX_ROWS = 25;

/**
 * Keep only absolute http(s) artwork URLs; Monochrome's proxy URLs are already
 * absolute, so nothing is rewritten here.
 */
function artwork(url) {
  const text = String(url ?? '').trim();
  return /^https?:\/\//i.test(text) ? text : undefined;
}

/**
 * Tidal reports duration in milliseconds. BitChord reads `duration` as seconds
 * and accepts a decimal, so the division is not optional — handing it 391376
 * would put every track's length out by a factor of a thousand and quietly
 * break matching against anything that knows the real runtime.
 */
function seconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / 100) / 10;
}

/** A search row, or null. Ids must be numeric: nothing else can be resolved. */
function mapTrack(item) {
  const id = String(item?.id ?? '').trim();
  const title = String(item?.title ?? '').trim();
  if (!/^\d+$/.test(id) || !title) return null;

  const hiRes =
    (Array.isArray(item?.artistNames) && Array.isArray(item?.mediaMetadata?.tags) &&
      item.mediaMetadata.tags.includes('HIRES_LOSSLESS')) ||
    /hi-?res/i.test(String(item?.audioQuality ?? ''));

  return {
    id: `tidal:${id}`,
    title,
    artist: Array.isArray(item.artistNames)
      ? item.artistNames.join(', ')
      : String(item.artistNames ?? item?.artist?.name ?? ''),
    // Monochrome's index does not say which release a row came from, and
    // BitChord's matcher treats a missing album as "unknown" rather than
    // "wrong" — which is the correct thing for it to treat it as.
    album: '',
    duration: seconds(item.duration),
    artworkURL: artwork(item.artwork),
    format: 'flac',
    audioQuality: hiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
    albumArtworkURL: undefined,
    _source: 'tidal',
    _nativeId: id,
    _isrc: item.isrc,
  };
}

export const tidal = {
  id: 'tidal',
  label: 'Tidal',
  /** Advertised so `/health` can say what is wired up, not as a BitChord concept. */
  lossless: true,
  baseUrl: BASE,

  /**
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array>} rows in BitChord's `tracks` shape
   */
  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const capped = Math.min(Math.max(Number(limit) || 20, 1), MAX_ROWS);

    return searchCache.wrap(`tidal:${text.toLowerCase()}:${capped}`, SEARCH_TTL_MS, async () => {
      const payload = await httpJson(
        `${BASE}/search/tracks?q=${encodeURIComponent(text)}&limit=${capped}`,
        { timeoutMs: 12_000, signal },
      );
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];

      const rows = [];
      const seen = new Set();
      for (const item of tracks) {
        // `playable: false` is Monochrome's own statement that the catalogue has
        // the metadata but no stream behind it. Handing those to BitChord spends
        // a `/stream` round trip to learn nothing.
        if (item?.playable === false) continue;
        const row = mapTrack(item);
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
        if (rows.length >= capped) break;
      }
      return rows;
    });
  },

  /**
   * Resolves one track to a FLAC URL plus what is genuinely known about it.
   *
   * The probe is the whole answer: this catalogue describes nothing, so what the
   * bytes say is what the row is labelled with. Where the header cannot be read
   * — a CDN that refuses the range request, a format change — this throws rather
   * than returning a URL it cannot vouch for, which is what sends the row into
   * failover where another catalogue may hold it.
   *
   * @param {string} nativeId
   * @param {string} tier BitChord's normalised tier
   */
  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!/^\d+$/.test(id)) throw new NotFound('no Tidal track id');

    // Asking for the tier costs nothing and is what the catalogue expects; the
    // probe below reports what actually arrived regardless of what was asked
    // for, which is the whole point of it.
    const quality = tier === 'LOSSLESS' ? 'LOSSLESS' : tier;
    const url = `${BASE}/track/${encodeURIComponent(id)}` +
      `?quality=${encodeURIComponent(quality)}`;

    // A rate limit is thrown rather than converted into a miss: the catalogue
    // has the file, it is asking to be asked again later, and reporting that as
    // "not held" is the one answer that loses the track.
    const answered = await probeFlac(url, {
      cacheKey: `tidal:${id}:${quality}`,
      signal,
    });

    if (!answered) {
      // Distinguishing "not FLAC" from "the CDN did not answer" matters: the
      // first is this catalogue serving something it did not promise, the second
      // is a transient failure another source may not share.
      throw new UpstreamError(
        `Tidal index served no readable FLAC for track ${id}`,
        { retryable: true },
      );
    }

    return {
      url: answered.url,
      codec: answered.codec,
      container: answered.container,
      manifest: 'none',
      encrypted: false,
      sampleRate: answered.sampleRate,
      bitDepth: answered.bitDepth,
      bitrate: answered.bitrate,
      channels: answered.channels,
      probed: true,
    };
  },

  /**
   * The media URL, for the optional proxy route.
   *
   * Quality is dropped deliberately: a proxied request is already the tail of
   * playback, and appending a parameter the upstream ignores only invites a
   * cache miss on every seek.
   */
  mediaUrl(nativeId) {
    return `${BASE}/track/${encodeURIComponent(String(nativeId))}`;
  },

  /** For the health route. */
  async health() {
    try {
      const payload = await httpJson(`${BASE}/search/tracks?q=music&limit=1`, {
        timeoutMs: 8_000,
        retries: 0,
      });
      const n = Array.isArray(payload?.tracks) ? payload.tracks.length : 0;
      return { ok: true, detail: `${n} result(s) for a probe query` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
