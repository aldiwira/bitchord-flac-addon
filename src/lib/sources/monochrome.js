/**
 * Monochrome, through its public instances.
 *
 * Monochrome is a client, not a catalogue: it aggregates Tidal metadata and asks
 * a public instance to mint a stream. The instances are other people's
 * deployments, and their list moves — which is why the registry is fetched
 * rather than hardcoded, and why the hardcoded list is a fallback rather than
 * the source of truth. When an instance dies this addon follows the registry to
 * a live one without a code change.
 *
 * ## The DASH rule
 *
 * An instance answers `/track/` with a base64 manifest that is either a JSON
 * blob of signed URLs or a DASH MPD. **DASH is refused and never returned as a
 * stream.** BitChord's player wants one progressive URL; handing it an MPD
 * either fails to start or starts and stalls. So a DASH answer is treated as
 * "this instance cannot serve this track", and the same track is asked for again
 * at the CD tier, where instances that only hold Hi-Res as DASH usually have a
 * progressive rendition. If that is also DASH, it is a miss.
 *
 * ## The id length rule
 *
 * Tidal ids are numeric and long. The modern API (`tracks.monochrome.st`) takes
 * them directly; the older instances take them too but answer for a different
 * catalogue. A short numeric id is an older catalogue handle that only the
 * instances know, so it skips the modern API rather than spending a round trip
 * to be told so.
 */

import { probeFlac } from '../probe.js';
import { httpJson, TtlCache, NotFound, UpstreamError } from '../http.js';

const MODERN = (process.env.MONOCHROME_BASE_URL || 'https://tracks.monochrome.st').replace(/\/+$/, '');

/**
 * The official instance registry. Read, not trusted blindly: entries are
 * validated and merged with the fallback list, so a registry that is empty or
 * unreachable costs nothing.
 */
const REGISTRY =
  'https://raw.githubusercontent.com/monochrome-music/monochrome/main/public/instances.json';

/** Instances known to have answered. Used when the registry does not. */
const FALLBACK_INSTANCES = [
  'https://wolf.qqdl.site',
  'https://maus.qqdl.site',
  'https://vogel.qqdl.site',
  'https://hund.qqdl.site',
  'https://tidal.kinoplus.online',
];

/**
 * Mirrored from the client. Some instances serve a placeholder to anything that
 * does not look like the app that owns them, and the difference between an
 * answer and a 403 costs nothing to avoid.
 */
const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'x-client': 'BiniLossless/v3.4',
  Origin: 'https://monochrome.st',
  Referer: 'https://monochrome.st/',
  Accept: 'application/json',
};

const INSTANCE_TTL_MS = 30 * 60 * 1000;
const MAX_ROWS = 20;

/**
 * Tidal ids are 15+ digits. Shorter ones are legacy handles that only the
 * instances resolve, so the modern API is skipped for them.
 */
const MODERN_MIN_ID_LENGTH = 15;

const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

let instanceCache = { at: 0, urls: [...FALLBACK_INSTANCES] };

function isValidInstance(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Live instance URLs, refreshed on a TTL.
 *
 * Never throws and never returns fewer than the fallback list: discovery is an
 * optimisation over the hardcoded set, so its failure must not cost this source.
 */
async function instances(signal) {
  if (Date.now() - instanceCache.at < INSTANCE_TTL_MS) return instanceCache.urls;

  try {
    const payload = await httpJson(REGISTRY, { timeoutMs: 6_000, retries: 0, signal });
    const listed = [
      ...(Array.isArray(payload?.api) ? payload.api : []),
      ...(Array.isArray(payload?.streaming) ? payload.streaming : []),
    ]
      .map((value) => String(value ?? '').trim().replace(/\/+$/, ''))
      .filter(isValidInstance);

    const merged = [...new Set([...listed, ...FALLBACK_INSTANCES])];
    if (merged.length) instanceCache = { at: Date.now(), urls: merged };
  } catch {
    // Keep whatever is already cached. A registry that is down says nothing
    // about whether the instances are.
  }

  return instanceCache.urls;
}

/**
 * One GET, tolerating every way an instance can decline.
 *
 * Returns null rather than throwing, because the caller is walking a list of
 * instances it does not control: a 403 and a timeout and an HTML error page are
 * all "ask the next one", not an error to propagate.
 */
async function tryJson(url, { timeoutMs = 8_000, signal } = {}) {
  try {
    const payload = await httpJson(url, {
      timeoutMs,
      retries: 0,
      headers: UPSTREAM_HEADERS,
      signal,
    });
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** Monochrome reports milliseconds; BitChord wants seconds. */
function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Some instances send seconds already. A track over an hour is the giveaway.
  return Math.round(n > 3_600 ? n / 1000 : n);
}

function absolute(url, base) {
  const text = String(url ?? '').trim();
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text)) return text;
  if (!base) return undefined;
  try {
    return new URL(text, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * The rows hidden in whatever shape an instance answered with.
 *
 * The modern API nests `items`, the instances answer `data.items`, and older
 * deployments answer `data` or `topResults`. All four are live, which is why
 * this looks defensive.
 */
function itemsFrom(payload) {
  const candidates = [
    payload?.items,
    payload?.data?.items,
    payload?.tracks,
    payload?.data?.tracks,
    Array.isArray(payload?.data) ? payload.data : null,
    Array.isArray(payload?.topResults) ? payload.topResults : null,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
}

/**
 * A search row, or null.
 *
 * Ids must be numeric: everything after them is a resolve call that the
 * catalogue would refuse, so an id of another shape is not offered.
 */
function mapTrack(item, base) {
  const id = String(item?.trackId ?? item?.id ?? '').trim();
  if (!/^\d+$/.test(id)) return null;

  const title = String(item?.title ?? '').trim();
  if (!title) return null;

  const artist = Array.isArray(item.artistNames) && item.artistNames.length
    ? item.artistNames.join(', ')
    : String(item?.artist?.name ?? item?.artists?.[0]?.name ?? '').trim();

  // `mediaMetadata.tags` is the modern API's Hi-Res statement. The instances do
  // not send it, and a row that does not say Hi-Res is not labelled Hi-Res.
  const hiRes =
    Array.isArray(item?.mediaMetadata?.tags) &&
    item.mediaMetadata.tags.includes('HIRES_LOSSLESS');

  return {
    id: `monochrome:${id}`,
    title,
    artist,
    album: String(item?.album?.title ?? item?.releaseTitle ?? '').trim(),
    duration: seconds(item?.duration),
    artworkURL: absolute(item?.artwork, base),
    format: 'flac',
    audioQuality: hiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
    _source: 'monochrome',
    _nativeId: id,
  };
}

/**
 * Decodes an instance's manifest into a media answer, or says it is DASH.
 *
 * `isDash` is a first-class answer rather than a failure: an instance that only
 * holds a DASH rendition is reporting something true about this track, and the
 * caller acts on it by asking again at the CD tier.
 */
function decodeManifest(manifest, mimeType = '', cacheKey) {
  if (!manifest || typeof manifest !== 'string') return null;

  let decoded;
  try {
    decoded = Buffer.from(manifest, 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
  if (!decoded) return null;

  if (mimeType.includes('dash+xml') || decoded.startsWith('<MPD') || decoded.startsWith('<?xml')) {
    return { isDash: true };
  }

  if (mimeType.includes('vnd.tidal.bts') || decoded.startsWith('{')) {
    let payload;
    try {
      payload = JSON.parse(decoded);
    } catch {
      return null;
    }
    const url = Array.isArray(payload.urls) ? payload.urls[0] : payload.url;
    if (!url || !/^https?:\/\//i.test(url)) return null;

    // The manifest states the audio format, which is what makes this cheap: no
    // probe is needed to answer honestly, and the URL a Tidal CDN mints is
    // stable for the life of the process.
    return {
      isDash: false,
      answer: {
        url,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        encrypted: false,
        sampleRate: Number(payload.sampleRate) || 44100,
        bitDepth: Number(payload.bitDepth) || 16,
        bitrate: Number(payload.bitrate) || undefined,
        probed: false,
        cacheKey,
      },
    };
  }

  return null;
}

/**
 * The modern API's track endpoint, which serves bytes rather than JSON.
 *
 * `tracks.monochrome.st/track/{id}` is the audio itself — the same shape the
 * Tidal source relies on — so there is nothing to parse and nothing to resolve.
 * It is probed like any other media URL, and a non-FLAC answer is reported as
 * what it is rather than as the Hi-Res it was asked for.
 *
 * This is worth stating because it is not obvious from the outside: the search
 * endpoint answers JSON, the track endpoint answers FLAC, and a relay that
 * wrapped both in JSON would have made this function unnecessary.
 */
async function resolveModern(id, quality, signal) {
  const url = `${MODERN}/track/${encodeURIComponent(id)}?quality=${encodeURIComponent(quality)}`;

  const described = await probeFlac(url, {
    cacheKey: `monochrome:${id}:${quality}`,
    signal,
  });

  // Null is the modern API declining — rate limited, or a track it holds no
  // file for. Both are a reason to ask the instances, not to stop.
  if (!described) return null;

  return { answer: described };
}

export const monochrome = {
  id: 'monochrome',
  label: 'Monochrome',
  lossless: true,
  baseUrl: MODERN,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const capped = Math.min(Math.max(Number(limit) || 20, 1), MAX_ROWS);

    return searchCache.wrap(`monochrome:${text.toLowerCase()}:${capped}`, SEARCH_TTL_MS, async () => {
      const rows = [];
      const seen = new Set();

      const push = (payload, base) => {
        for (const item of itemsFrom(payload)) {
          const row = mapTrack(item, base);
          if (!row || seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
          if (rows.length >= capped) break;
        }
      };

      // The modern API answers in one request and is the fastest path, so it is
      // asked first and the instances only fill the remainder.
      push(
        await tryJson(`${MODERN}/search?q=${encodeURIComponent(text)}`, { timeoutMs: 5_000, signal }),
        MODERN,
      );

      if (rows.length < capped) {
        const urls = await instances(signal);
        const settled = await Promise.allSettled(
          urls.slice(0, 6).map(async (base) => ({
            base,
            payload: await tryJson(`${base}/search/?s=${encodeURIComponent(text)}`, { signal }),
          })),
        );

        for (const entry of settled) {
          if (entry.status !== 'fulfilled' || !entry.value.payload) continue;
          push(entry.value.payload, entry.value.base);
          if (rows.length >= capped) break;
        }
      }

      return rows.slice(0, capped);
    });
  },

  /**
   * Resolves one track to a progressive FLAC URL.
   *
   * Instances are asked in parallel rather than in sequence — they are peers, and
   * a dead one must not cost the list's whole timeout. DASH answers are
   * collected and retried at the CD tier afterwards, in registry order, because
   * that retry is the one thing worth a second round trip.
   */
  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!/^\d+$/.test(id)) throw new NotFound('no Monochrome track id');

    // Lossless is the only tier this addon serves; ask for it by name because
    // the instances expect that vocabulary.
    const quality = tier === 'LOSSLESS' ? 'LOSSLESS' : tier;

    if (id.length >= MODERN_MIN_ID_LENGTH) {
      const modern = await resolveModern(id, quality, signal);
      if (modern?.answer) return modern.answer;
      // A DASH answer from the modern API is conclusive: no instance will have
      // a progressive rendition of a track the canonical API only holds as DASH.
      if (modern?.isDash) throw new NotFound('Monochrome holds this track only as DASH');
    }

    const urls = await instances(signal);
    const settled = await Promise.allSettled(
      urls.slice(0, 6).map(async (base) => ({
        base,
        payload: await tryJson(
          `${base}/track/?id=${encodeURIComponent(id)}&quality=${encodeURIComponent(quality)}`,
          { signal },
        ),
      })),
    );

    const dashInstances = [];

    for (const entry of settled) {
      if (entry.status !== 'fulfilled' || !entry.value.payload) continue;
      const { base, payload } = entry.value;

      const body = payload?.data ?? payload;
      if (!body?.manifest) continue;

      // A preview is a 30-second clip. Serving it as the track would be worse
      // than a miss: it plays, and it is the wrong audio.
      if (body.assetPresentation === 'PREVIEW') continue;

      const decoded = decodeManifest(
        body.manifest,
        String(body.manifestMimeType ?? ''),
        `monochrome:${id}:${quality}:${base}`,
      );
      if (!decoded) continue;
      if (decoded.isDash) {
        dashInstances.push(base);
        continue;
      }
      return decoded.answer;
    }

    // The retry: an instance holding only a Hi-Res DASH rendition usually has a
    // CD-quality progressive one. Asked at LOSSLESS explicitly.
    for (const base of dashInstances) {
      if (signal?.aborted) break;
      const payload = await tryJson(
        `${base}/track/?id=${encodeURIComponent(id)}&quality=LOSSLESS`,
        { signal },
      );
      const body = payload?.data ?? payload;
      if (!body?.manifest) continue;
      if (body.assetPresentation === 'PREVIEW') continue;

      const decoded = decodeManifest(
        body.manifest,
        String(body.manifestMimeType ?? ''),
        `monochrome:${id}:LOSSLESS:${base}`,
      );
      if (decoded && !decoded.isDash) return decoded.answer;
    }

    throw new NotFound('no Monochrome instance has a progressive stream for this track');
  },

  async health() {
    try {
      const payload = await httpJson(`${MODERN}/search?q=music`, { timeoutMs: 8_000, retries: 0 });
      const n = itemsFrom(payload).length;
      const known = (await instances()).length;
      return { ok: true, detail: `${n} result(s) for a probe query; ${known} instance(s) known` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
