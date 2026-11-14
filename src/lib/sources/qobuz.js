/**
 * Qobuz, through a public relay.
 *
 * The only source here that can serve **Hi-Res**: 24-bit, up to 192 kHz, when
 * the upstream has it. That is worth the fragility — `soundfean-musics` is a
 * Render-hosted proxy, so its first request after idle can take longer than any
 * sensible timeout, and its answers are only as current as its own session.
 *
 * Two tiers of upstream, and the fallback is the point:
 *
 *   default     `QOBUZ_UPSTREAM_BASE_URL` — a relay that answers `/search` and
 *               `/stream/{id}` with a signed URL it obtained itself
 *   self-hosted `QOBUZ_REST_API` — your own `qobuz-rest-api`, which the relay
 *               is presumably wrapping. Asked directly and preferred when set,
 *               because it is the only path where the answer is your own account
 *               rather than someone else's.
 *
 * Neither needs credentials here. Which is also the honest caveat: a relay's
 * idea of "HI_RES" is only as good as its session, so every answer is probed
 * unless the relay already stated the codec and the headers — and when it
 * states nothing, the probe decides rather than the request that was made.
 */

import { describeMedia } from '../probe.js';
import { httpJson, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = (process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com/u/tpg000.vxrtcq1VeQcF0m1koi0Ncw.ThwpJfA6x3aCvX1oGq5iV_')
  .replace(/\/+$/, '');
const SELF_HOSTED = String(process.env.QOBUZ_REST_API || '').replace(/\/+$/, '');

const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

/**
 * BitChord's tier vocabulary mapped to Qobuz's own.
 *
 * Ask for Hi-Res whenever lossless is wanted, because the whole reason this
 * source exists is the 24-bit catalogue and a request for CD quality cannot be
 * upgraded by the far end. What arrives is probed either way.
 */
const UPSTREAM_QUALITY = {
  LOSSLESS: 'HI_RES',
  HIGH: 'LOSSLESS',
  LOW: 'LOW',
};

const MAX_ROWS = 25;

function artworkUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** Qobuz relays state either a duration in seconds or, confusingly, in ms. */
function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n > 3_600 ? n / 1000 : n);
}

/**
 * A search row, or null when the item cannot be turned into one.
 *
 * `hiRes` is read from the catalogue's own `audioQuality` string rather than
 * assumed from the request: a relay asked for HI_RES that only has CD quality
 * answers with CD quality, and announcing Hi-Res on that row would be a claim
 * this addon cannot keep.
 */
function mapTrack(item) {
  const id = String(item?.id ?? '').trim();
  const title = String(item?.title ?? '').trim();
  // Ids are numeric Qobuz track ids. Anything else is a row this addon could not
  // resolve later, so it is not offered now.
  if (!/^\d+$/.test(id) || !title) return null;

  const hiRes = /24[\s-]*bit|hi-?res/i.test(String(item?.audioQuality ?? item?.quality ?? ''));

  return {
    id: `qobuz:${id}`,
    title,
    artist: String(item?.artist ?? item?.performer?.name ?? '').trim(),
    album: String(item?.album ?? item?.albumTitle ?? '').trim(),
    duration: seconds(item?.duration),
    artworkURL: artworkUrl(item?.artworkURL ?? item?.image ?? item?.cover),
    format: 'flac',
    audioQuality: hiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
    _source: 'qobuz',
    _nativeId: id,
  };
}

/**
 * The one place this source decides where to ask.
 *
 * A self-hosted API is preferred when configured: it is the answer from your own
 * account, and it does not disappear when someone else's relay does.
 */
async function relayJson(path, signal) {
  if (SELF_HOSTED) {
    return httpJson(`${SELF_HOSTED}${path}`, { timeoutMs: 12_000, retries: 1, signal });
  }
  return httpJson(`${BASE}${path}`, { timeoutMs: 15_000, retries: 1, signal });
}

export const qobuz = {
  id: 'qobuz',
  label: 'Qobuz',
  lossless: true,
  hiRes: true,
  baseUrl: SELF_HOSTED || BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const capped = Math.min(Math.max(Number(limit) || 20, 1), MAX_ROWS);

    return searchCache.wrap(`qobuz:${text.toLowerCase()}:${capped}`, SEARCH_TTL_MS, async () => {
      let payload;
      try {
        payload = await relayJson(
          `/search?q=${encodeURIComponent(text)}&quality=LOSSLESS&limit=${capped}`,
          signal,
        );
      } catch (error) {
        // A relay that is down costs this source's rows, never the search: the
        // handler turns a rejected source into a partial result.
        if (error instanceof NotFound) return [];
        throw error;
      }

      const items = Array.isArray(payload?.tracks)
        ? payload.tracks
        : Array.isArray(payload?.data?.tracks)
          ? payload.data.tracks
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

      const rows = [];
      const seen = new Set();
      for (const item of items) {
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
   * Resolves one track to a signed media URL plus what it actually carries.
   *
   * The relay's own fields are trusted only where they are checkable: a URL is
   * probed, and a relay that states a sample rate it cannot back up is corrected
   * by the bytes. Where the probe fails but the relay named a codec, the answer
   * is that codec unprobed rather than a refusal — the track plays, and
   * `probed: false` is visible to `/health` and the contract check.
   */
  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!/^\d+$/.test(id)) throw new NotFound('no Qobuz track id');

    const upstreamQuality = UPSTREAM_QUALITY[tier] ?? 'HI_RES';

    let payload;
    if (SELF_HOSTED) {
      payload = await httpJson(
        `${SELF_HOSTED}/track/getStreamUrl?id=${encodeURIComponent(id)}` +
          `&quality=${encodeURIComponent(tier || 'LOSSLESS')}`,
        { timeoutMs: 12_000, retries: 1, signal },
      ).catch((error) => {
        if (error instanceof NotFound) return null;
        throw error;
      });
    } else {
      payload = await relayJson(
        `/stream/${encodeURIComponent(id)}?quality=${upstreamQuality}`,
        signal,
      ).catch((error) => {
        if (error instanceof NotFound) return null;
        throw error;
      });
    }

    const url = String(payload?.url ?? payload?.data?.url ?? '').trim();
    if (!url) throw new NotFound('Qobuz relay has no stream for this track');

    // A relay that hands back something that is not https is handing back a
    // problem: BitChord will refuse to open it, and this addon will not offer it.
    if (!/^https:\/\//i.test(url)) {
      throw new UpstreamError('Qobuz relay returned a non-https media URL', { retryable: false });
    }

    // `encrypted: true` is the relay admitting DRM or a format this addon cannot
    // serve. BitChord rejects those outright, so this is a miss, not a stream.
    if (payload?.encrypted === true) throw new NotFound('Qobuz relay marked this stream encrypted');

    const declaredCodec = String(payload?.codec ?? '').toLowerCase() || undefined;

    const described = await describeMedia(url, {
      codec: declaredCodec && declaredCodec !== 'flac' ? declaredCodec : 'flac',
      cacheKey: `qobuz:${id}:${upstreamQuality}`,
      signal,
    });

    if (!described) throw new NotFound('Qobuz stream was neither FLAC nor a named codec');
    if (described.encrypted === true) throw new NotFound('Qobuz stream is encrypted');

    return described;
  },

  /** For the health route. */
  async health() {
    const endpoint = SELF_HOSTED ? `${SELF_HOSTED}/track/getStreamUrl?id=0` : `${BASE}/search?q=music`;
    try {
      const payload = await httpJson(endpoint, { timeoutMs: 10_000, retries: 0 });
      const n = Array.isArray(payload?.tracks) ? payload.tracks.length : 0;
      return {
        ok: true,
        detail: SELF_HOSTED
          ? 'self-hosted qobuz-rest-api answered'
          : `relay answered, ${n} result(s) for a probe query`,
      };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
