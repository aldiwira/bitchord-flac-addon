/**
 * NetEase Cloud Music, through a Meting API instance.
 *
 * The Meting endpoint does the NetEase signing and, on the public instance,
 * carries the VIP cookie needed for lossless. `br=2000` asks for FLAC; tracks
 * without a lossless rendition fall back to MP3 and the redirect target's
 * extension is what tells the two apart. The bytes are then probed exactly like
 * every other source here, so the reported quality is read rather than asserted.
 *
 * Search does not go through Meting first. Meting's `type=search` row is
 * `{name, artist, url, pic, lrc}` with no album, and filling that in costs a
 * second round trip to NetEase — measured at 1.7–2.4 s, on top of a Meting
 * search that itself ranged 1.2–3.5 s. NetEase's own unsigned search endpoint
 * answers the same query in a steady ~1.3 s *with* the album, so it is the
 * primary path and Meting is the fallback for when it does not answer. Nothing
 * in the fallback can drop rows: a failed album lookup leaves `album` empty and
 * the search still returns what it found.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound } from '../http.js';

const BASE = (process.env.NETEASEV2_API_BASE || 'https://api.qijieya.cn/meting')
  .replace(/\/+$/, '');
const SERVER = process.env.NETEASEV2_SERVER || 'netease';

/**
 * NetEase's own search, unsigned and unauthenticated.
 *
 * Set it to an empty string to skip it and always search through Meting.
 */
const SEARCH_BASE =
  (process.env.NETEASEV2_SEARCH_BASE ?? 'https://music.163.com/api/search/get')
    .trim()
    .replace(/\/+$/, '');

/**
 * Meting's `type=search` row is `{name, artist, url, pic, lrc}` — the album is
 * not in the response at all, so every row this source produced carried an
 * empty album and BitChord had nothing to show there. NetEase's own detail
 * endpoint (unsigned and unauthenticated) answers the album for a whole batch
 * of ids in one request, which is what fills the gap on the Meting path.
 */
const DETAIL_BASE =
  (process.env.NETEASEV2_DETAIL_BASE || 'https://music.163.com/api/song/detail')
    .replace(/\/+$/, '');

const NETEASE_HEADERS = { Referer: 'https://music.163.com/' };

/** Meting's lossless selector. Lower values map to 320/192/128 MP3. */
const MAX_BR = 2000;
const DETAIL_CHUNK = 50;

/**
 * The album lookup's whole budget.
 *
 * The album is decoration on a search row; whether it arrives must never decide
 * whether the rows do. A client that gives up on `/search` after a few seconds
 * shows nothing at all, so this is capped well under that rather than being
 * allowed to run the request's full deadline.
 */
const DETAIL_TIMEOUT_MS = 2_000;
const searchCache = new TtlCache(2_000);
const urlCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;
const URL_TTL_MS = 5 * 60 * 1000;

const AUDIO_EXTENSIONS = ['flac', 'mp3', 'aac', 'm4a', 'opus', 'ogg'];

/** Upgrades the plain-HTTP URLs a CDN may hand out. */
export function httpsUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.replace(/^http:\/\//i, 'https://');
}

/** Reads the NetEase song id out of a Meting `type=url` link. */
export function songIdFromUrl(value) {
  try {
    const id = new URL(String(value ?? '')).searchParams.get('id');
    return id ? String(id).trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** The codec named by a redirected CDN path, or undefined when it names none. */
export function codecFromUrl(value) {
  try {
    const ext = new URL(String(value ?? '')).pathname.split('.').pop()?.toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext) ? ext : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the album fields out of one `song/detail` entry. */
export function albumFromDetail(song) {
  const album = song?.al ?? song?.album;
  const name = String(album?.name ?? album ?? '').trim();
  const artwork = httpsUrl(album?.picUrl ?? song?.picUrl);
  return { album: name, artworkURL: artwork };
}

/**
 * Meting's `type=pic` proxy, which dereferences a NetEase album picture id.
 *
 * NetEase's search gives the album a `picId` and a null `picUrl`, so this is the
 * cover's only route. The id must be exact: a rounded one addresses a different
 * album's cover, which is why the search payload is parsed with
 * `preserveIntegers` and every other numeric field here is still a number.
 */
export function picUrl(picId) {
  const id = String(picId ?? '').trim();
  if (!id || id === '0') return undefined;
  return `${BASE}/?server=${encodeURIComponent(SERVER)}&type=pic&id=${encodeURIComponent(id)}`;
}

/**
 * A search row from NetEase's own search.
 *
 * Duration and album both arrive here, so nothing has to be looked up a second
 * time: the same payload that names a track also names the release it is on.
 * The album `picUrl` is null in this payload, but the `picId` is not, and
 * Meting's `type=pic` proxy dereferences it into a cover.
 */
export function mapNeteaseRow(song) {
  const id = song?.id ?? song?.songId;
  const title = String(song?.name ?? song?.title ?? '').trim();
  if (id == null || !id || !title) return null;

  const artists = Array.isArray(song?.artists)
    ? song.artists
    : Array.isArray(song?.ar)
      ? song.ar
      : [];
  const artist = artists
    .map((entry) => String(entry?.name ?? '').trim())
    .filter(Boolean)
    .join(', ');
  const album = song?.album ?? song?.al ?? {};
  const ms = Number(song?.duration ?? song?.dt);

  return {
    id: `netease:${id}`,
    title,
    artist,
    album: String(album?.name ?? '').trim(),
    duration: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : undefined,
    artworkURL: httpsUrl(album?.picUrl) ?? picUrl(album?.picId),
    format: 'flac',
    audioQuality: 'LOSSLESS',
    _source: 'netease',
    _nativeId: String(id),
  };
}

/** A search row from a Meting row, which carries no album and no duration. */
export function mapMetingRow(row, album) {
  const id = songIdFromUrl(row?.url) ?? row?.id ?? row?.songId;
  const title = String(row?.name ?? row?.title ?? '').trim();
  if (!id || !title) return null;

  const artist = String(row?.artist ?? row?.artists ?? '')
    .split('/')
    .map((name) => name.trim())
    .filter(Boolean)
    .join(', ');

  return {
    id: `netease:${id}`,
    title,
    artist,
    album: album?.album ?? '',
    artworkURL: album?.artworkURL ?? httpsUrl(row?.pic ?? row?.artworkURL),
    format: 'flac',
    audioQuality: 'LOSSLESS',
    _source: 'netease',
    _nativeId: String(id),
  };
}

/**
 * Albums for a batch of NetEase ids, keyed by id.
 *
 * Best-effort by contract: a search that answered is still a search worth
 * returning when this call times out, so a failure yields whatever was
 * collected and the rows keep an empty album rather than being dropped. An
 * incomplete batch is not cached, so one bad minute is not inherited by every
 * search for the next five.
 */
export async function fetchAlbums(ids, signal) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();

  const key = `netease:detail:${wanted.join(',')}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  // One shared clock for the whole batch, so fifty ids cannot turn into fifty
  // chances to spend the budget.
  const deadline = AbortSignal.timeout(DETAIL_TIMEOUT_MS);
  const composed = signal ? AbortSignal.any([deadline, signal]) : deadline;

  const albums = new Map();
  let complete = true;
  for (let i = 0; i < wanted.length; i += DETAIL_CHUNK) {
    const chunk = wanted.slice(i, i + DETAIL_CHUNK);
    const url = `${DETAIL_BASE}?ids=${encodeURIComponent(JSON.stringify(songsPayload(chunk)))}`;
    let payload;
    try {
      payload = await httpJson(url, {
        timeoutMs: DETAIL_TIMEOUT_MS,
        retries: 0,
        headers: NETEASE_HEADERS,
        signal: composed,
      });
    } catch {
      // NetEase being unreachable is not a search failure: the rows are
      // already in hand and an empty album is how they start anyway.
      complete = false;
      break;
    }
    const songs = Array.isArray(payload?.songs) ? payload.songs : [];
    for (const song of songs) {
      const id = song?.id;
      if (id == null) continue;
      const { album, artworkURL } = albumFromDetail(song);
      if (album || artworkURL) albums.set(String(id), { album, artworkURL });
    }
  }

  if (complete) searchCache.set(key, albums, SEARCH_TTL_MS);
  return albums;
}

/** Merges an album lookup into rows, leaving every row that has no answer as it was. */
export function withAlbums(rows, albums) {
  if (!albums.size) return rows;
  return rows.map((row) => {
    const album = albums.get(row._nativeId);
    if (!album) return row;
    return {
      ...row,
      album: album.album || row.album,
      artworkURL: album.artworkURL ?? row.artworkURL,
    };
  });
}

/** The id list NetEase accepts, as numbers for real ids and as-is otherwise. */
export function songsPayload(ids) {
  return [...new Set(ids.filter(Boolean))].map((id) => Number(id) || id);
}

/**
 * Search through NetEase's own endpoint.
 *
 * Returns null — not an empty array — when the endpoint did not answer, so the
 * caller can tell "no such song" from "ask somebody else". An empty array is a
 * real answer and is returned as one.
 */
export async function searchViaNetease(text, capped, signal) {
  if (!SEARCH_BASE) return null;
  let payload;
  try {
    payload = await httpJson(
      `${SEARCH_BASE}?s=${encodeURIComponent(text)}&type=1&limit=${capped}`,
      {
        timeoutMs: 8_000,
        retries: 0,
        headers: NETEASE_HEADERS,
        signal,
        preserveIntegers: true,
      },
    );
  } catch {
    return null;
  }
  const songs = Array.isArray(payload?.result?.songs)
    ? payload.result.songs
    : Array.isArray(payload?.songs)
      ? payload.songs
      : null;
  if (!songs) return null;
  return songs.map(mapNeteaseRow).filter(Boolean).slice(0, capped);
}

/**
 * Search through Meting, then fill the album from NetEase's detail endpoint.
 *
 * The fallback never drops a row over a missing album: `fetchAlbums` answers an
 * empty map when it cannot, and `withAlbums` then returns the rows unchanged.
 */
async function searchViaMeting(text, capped, signal) {
  const payload = await httpJson(
    `${BASE}/?server=${encodeURIComponent(SERVER)}` +
      `&type=search&id=${encodeURIComponent(text)}&limit=${capped}`,
    { timeoutMs: 12_000, signal },
  );
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const mapped = rows.map((row) => mapMetingRow(row)).filter(Boolean).slice(0, capped);
  const albums = await fetchAlbums(
    mapped.map((row) => row._nativeId),
    signal,
  );
  return withAlbums(mapped, albums);
}

/** Reads only the first bytes, so an ignored Range request cannot pull the file. */
async function readHead(response, size) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < size) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, size);
}

/** Total file size from `Content-Range` when ranged, else `Content-Length`. */
function totalBytes(response) {
  const contentRange = response.headers.get('content-range') ?? '';
  const slash = contentRange.lastIndexOf('/');
  const fromRange = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;
  if (Number.isFinite(fromRange) && fromRange > 0) return fromRange;
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

export const netease = {
  id: 'netease',
  label: 'NetEase V2',
  lossless: true,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    return searchCache.wrap(`netease:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
      const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
      // Primary: one request, album and duration included, measured steady at
      // ~1.3 s. A null here means the endpoint did not answer — not that the
      // song does not exist — so the fallback runs. A non-null empty array is a
      // real "nothing matched" and must not be second-guessed.
      const direct = await searchViaNetease(text, capped, signal);
      if (direct) return direct;
      return searchViaMeting(text, capped, signal);
    });
  },

  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!id) throw new NotFound('no track id');

    return urlCache.wrap(`netease:url:${id}`, URL_TTL_MS, async () => {
      const target = `${BASE}/?server=${encodeURIComponent(SERVER)}` +
        `&type=url&id=${encodeURIComponent(id)}&br=${MAX_BR}`;

      let response;
      try {
        response = await httpGet(target, {
          timeoutMs: 12_000,
          retries: 1,
          range: `bytes=0-${STREAMINFO_BYTES - 1}`,
          signal,
        });
      } catch (error) {
        if (error instanceof NotFound) {
          throw new NotFound('NetEase has no playable rendition for this track');
        }
        throw error;
      }

      // Meting answers an unavailable track with an empty 200 and no redirect,
      // so a final URL that never left the API host names no codec.
      const streamUrl = httpsUrl(response.url || target);
      const codec = codecFromUrl(streamUrl);
      if (!codec) throw new NotFound('NetEase has no playable rendition for this track');

      const head = await readHead(response, STREAMINFO_BYTES);

      if (codec !== 'flac') {
        return {
          url: streamUrl,
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

      const info = parseFlacStreamInfo(head);
      const total = totalBytes(response);
      return {
        url: streamUrl,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        encrypted: false,
        sampleRate: info?.sampleRate ?? null,
        bitDepth: info?.bitDepth ?? null,
        bitrate: info && total ? flacKbps(total, info.durationSec) : null,
        channels: info?.channels ?? null,
        probed: Boolean(info),
        error: info ? undefined : 'served, but the FLAC header could not be read',
      };
    });
  },

  /**
   * Reports both paths, because they fail independently.
   *
   * Meting is what `resolve` needs, so it decides `ok`: with Meting down a
   * search can still answer through NetEase's own endpoint, but no row from
   * this source can be played. NetEase's search is reported beside it, because
   * "search fell back" and "playback is down" are different problems.
   */
  async health() {
    const probe = async (url) => {
      try {
        const payload = await httpJson(url, { timeoutMs: 8_000, retries: 0 });
        const n = Array.isArray(payload)
          ? payload.length
          : Array.isArray(payload?.result?.songs)
            ? payload.result.songs.length
            : Array.isArray(payload?.songs)
              ? payload.songs.length
              : 0;
        return { ok: true, detail: `${n} result(s)` };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    };

    const [direct, meting] = await Promise.all([
      SEARCH_BASE
        ? probe(`${SEARCH_BASE}?s=music&type=1&limit=1`)
        : Promise.resolve({ ok: false, detail: 'disabled' }),
      probe(`${BASE}/?server=${encodeURIComponent(SERVER)}&type=search&id=music&limit=1`),
    ]);

    return {
      ok: meting.ok,
      detail: `netease search ${direct.ok ? 'ok' : 'down'} (${direct.detail}); ` +
        `meting ${meting.ok ? 'ok' : 'down'} (${meting.detail})`,
    };
  },
};
