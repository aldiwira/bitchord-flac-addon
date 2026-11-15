/**
 * Qobuz, through the Lossless Bridge.
 *
 * The only source here that can serve **Hi-Res**: 24-bit, up to 192 kHz, when
 * the upstream has it.
 *
 * ## The upstream is not a Qobuz relay any more
 *
 * It speaks this addon's own protocol — `/search?q=` returning `{tracks}` in
 * BitChord's row shape, `/stream/{id}?quality=` returning `{url}`, and `/health`
 * — and it aggregates several catalogues behind those two routes. Its ids carry
 * the catalogue they came from:
 *
 *   `td_…`  Tidal, via Monochrome
 *   `qq_…`  QQ Music, the usual Hi-Res 24-bit/192 kHz source
 *   `ne_…`  NetEase
 *
 * Two consequences, both of which broke this file when the upstream changed:
 *
 * 1. **Ids are not numeric.** The old contract used bare Qobuz track ids and
 *    `mapTrack` rejected anything else, so every row was dropped and `search`
 *    returned nothing at all. The id is now whatever the upstream issued,
 *    passed back verbatim.
 * 2. **Rows already carry a `source`.** This source is named `qobuz` because
 *    that is the prefix already in clients' queues, not because every row is
 *    from Qobuz. The upstream's `/health` currently reports its own `qobuz`
 *    backend as disabled.
 *
 * ## Two upstreams, and the fallback is the point
 *
 *   default     `QOBUZ_UPSTREAM_BASE_URL` — a public bridge instance
 *   self-hosted `QOBUZ_REST_API` — your own, asked directly and preferred when
 *               set, because it is the only path under your own control
 *
 * Neither needs credentials here. Which is also the honest caveat: the bridge's
 * idea of "HI_RES" is only as good as the backend it reached, so every answer is
 * probed rather than trusted.
 */

import { describeMedia } from '../probe.js';
import { httpJson, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = (process.env.QOBUZ_UPSTREAM_BASE_URL ||
  'https://losslessbridge.de.deplexo.com/u/tpg000.vxrtcq1VeQcF0m1koi0Ncw.ThwpJfA6x3aCvX1oGq5iV_')
  .replace(/\/+$/, '');
const SELF_HOSTED = String(process.env.QOBUZ_REST_API || '').replace(/\/+$/, '');

const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

/**
 * BitChord's tier vocabulary mapped to the bridge's own.
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

/**
 * The id the bridge issued, or null when it did not issue one.
 *
 * Deliberately not a pattern match on the catalogue prefixes. The bridge gains
 * backends over time — `gd_`, `ja_` and anything after them — and a whitelist
 * here is how this file silently returned zero rows for a whole upstream. The
 * only things an id must be are non-empty, and safe in a URL path segment.
 */
export function bridgeId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 200) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : null;
}

function artworkUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** The bridge states a duration in seconds; older relays sometimes sent ms. */
export function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n > 3_600 ? n / 1000 : n);
}

/**
 * A search row, or null when the item cannot be turned into one.
 *
 * `hiRes` is read from the bridge's own `audioQuality` string rather than
 * assumed from the request: a bridge asked for HI_RES that only reached a CD
 * backend answers with CD quality, and announcing Hi-Res on that row would be a
 * claim this addon cannot keep.
 */
export function mapTrack(item) {
  const id = bridgeId(item?.id);
  const title = String(item?.title ?? '').trim();
  if (!id || !title) return null;

  const stated = String(item?.audioQuality ?? item?.quality ?? '');
  const hiRes = /24[\s-]*bit|hi-?res/i.test(stated);

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
 * A self-hosted bridge is preferred when configured: it is the answer under your
 * own control, and it does not disappear when someone else's instance does.
 */
async function bridgeJson(path, signal) {
  if (SELF_HOSTED) {
    return httpJson(`${SELF_HOSTED}${path}`, { timeoutMs: 12_000, retries: 1, signal });
  }
  return httpJson(`${BASE}${path}`, { timeoutMs: 15_000, retries: 1, signal });
}

export const qobuz = {
  id: 'qobuz',
  label: 'Qobuz (Lossless Bridge)',
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
        payload = await bridgeJson(
          `/search?q=${encodeURIComponent(text)}&quality=LOSSLESS&limit=${capped}`,
          signal,
        );
      } catch (error) {
        // A bridge that is down costs this source's rows, never the search: the
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
   * The bridge's own fields are trusted only where they are checkable: a URL is
   * probed, and a bridge that states a sample rate it cannot back up is
   * corrected by the bytes. Where the probe fails but the bridge named a codec,
   * the answer is that codec unprobed rather than a refusal — the track plays,
   * and `probed: false` is visible to `/health` and the contract check.
   */
  async resolve(nativeId, tier, signal) {
    const id = bridgeId(nativeId);
    if (!id) throw new NotFound('no usable bridge track id');

    const upstreamQuality = UPSTREAM_QUALITY[tier] ?? 'HI_RES';

    const payload = await bridgeJson(
      `/stream/${encodeURIComponent(id)}?quality=${encodeURIComponent(upstreamQuality)}`,
      signal,
    ).catch((error) => {
      if (error instanceof NotFound) return null;
      throw error;
    });

    const url = String(payload?.url ?? payload?.data?.url ?? '').trim();
    if (!url) throw new NotFound('the lossless bridge has no stream for this track');

    // A bridge that hands back something that is not https is handing back a
    // problem: BitChord will refuse to open it, and this addon will not offer it.
    if (!/^https:\/\//i.test(url)) {
      throw new UpstreamError('the lossless bridge returned a non-https media URL', {
        retryable: false,
      });
    }

    // `encrypted: true` is the bridge admitting DRM or a format this addon cannot
    // serve. BitChord rejects those outright, so this is a miss, not a stream.
    if (payload?.encrypted === true) {
      throw new NotFound('the lossless bridge marked this stream encrypted');
    }

    const declaredCodec = String(payload?.codec ?? '').toLowerCase() || undefined;

    const described = await describeMedia(url, {
      codec: declaredCodec && declaredCodec !== 'flac' ? declaredCodec : 'flac',
      cacheKey: `qobuz:${id}:${upstreamQuality}`,
      signal,
    });

    if (!described) throw new NotFound('bridge stream was neither FLAC nor a named codec');
    if (described.encrypted === true) throw new NotFound('bridge stream is encrypted');

    return described;
  },

  /**
   * For the health route.
   *
   * The bridge's `/health` is what makes this worth reporting at all: it names
   * the backends behind `/search`, so "the bridge answered" and "the bridge can
   * serve Hi-Res" are distinguishable. A degraded backend is reported rather
   * than treated as failure — the bridge still answers, it just reaches fewer
   * catalogues.
   */
  async health() {
    const root = SELF_HOSTED || BASE;
    try {
      const payload = await httpJson(`${root}/health`, { timeoutMs: 10_000, retries: 0 });
      const states = payload?.sources ?? {};
      const degraded = Object.entries(states)
        .filter(([, value]) => value?.state && value.state !== 'ok')
        .map(([name, value]) => `${name}:${value.state}`);

      return {
        ok: payload?.ok !== false,
        detail: `bridge ${payload?.version ?? '?'} · ` +
          `${Object.keys(states).length} backend(s)` +
          (degraded.length ? ` · ${degraded.join(', ')}` : ''),
      };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
