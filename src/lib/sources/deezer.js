/**
 * Deezer, as a catalogue and nothing else.
 *
 * The API is public, unauthenticated and fast, and it knows what recording a
 * track id refers to. What it will not do is serve a lossless file, and this
 * addon only serves FLAC — so a Deezer row is a *reference*, not a stream.
 *
 * That is the useful half of it. Deezer's catalogue is the broadest of the
 * sources here, and its rows carry an ISRC, which is the one identifier that
 * means the same recording everywhere. A row that no other catalogue matched by
 * title is still matchable by ISRC.
 *
 * `resolve` is deliberately absent rather than throwing. `catalogueOnly` is the
 * honest statement, and the resolver treats a row from such a source as a miss
 * at that source, which sends it straight to failover — where the Deezer id is
 * resolved against a catalogue that can actually play it. This is the behaviour
 * the addon exists for: `dz:` rows play.
 */

import { httpJson, TtlCache } from '../http.js';

const API = (process.env.DEEZER_API_BASE || 'https://api.deezer.com').replace(/\/+$/, '');
const MAX_ROWS = 20;

const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

/** Deezer cover art comes in five sizes; the largest is the only one worth it. */
function cover(album) {
  return (
    album?.cover_xl ||
    album?.cover_big ||
    album?.cover_medium ||
    album?.cover ||
    undefined
  );
}

/**
 * A search row, or null.
 *
 * Ids must be numeric: a Deezer id of another shape is a row nothing downstream
 * can resolve, so it is not offered.
 */
function mapTrack(item) {
  const id = String(item?.id ?? '').trim();
  const title = String(item?.title ?? '').trim();
  if (!/^\d+$/.test(id) || !title) return null;

  return {
    id: `deezer:${id}`,
    title,
    artist: String(item?.artist?.name ?? '').trim(),
    album: String(item?.album?.title ?? '').trim(),
    duration: Number(item?.duration) > 0 ? Number(item.duration) : undefined,
    artworkURL: cover(item?.album),
    albumArtworkURL: cover(item?.album),
    format: 'flac',
    audioQuality: 'LOSSLESS',
    _source: 'deezer',
    _nativeId: id,
    // The one identifier that is portable across catalogues. Carried on the row
    // so a failover has a second way to recognise the recording than its title.
    _isrc: String(item?.isrc ?? '').trim() || undefined,
  };
}

export const deezer = {
  id: 'deezer',
  label: 'Deezer',
  /**
   * Deezer has no `resolve`. Stated here rather than left implied, because it is
   * what makes a `deezer:` row resolve somewhere else instead of failing.
   */
  catalogueOnly: true,
  lossless: false,
  baseUrl: API,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const capped = Math.min(Math.max(Number(limit) || 20, 1), MAX_ROWS);

    return searchCache.wrap(`deezer:${text.toLowerCase()}:${capped}`, SEARCH_TTL_MS, async () => {
      const payload = await httpJson(
        `${API}/search?q=${encodeURIComponent(text)}&limit=${capped}`,
        { timeoutMs: 8_000, retries: 1, signal },
      );

      // Deezer reports a query it dislikes in `error` with a 200 status.
      if (payload?.error) {
        // A quota error is the source being unavailable; anything else is this
        // query being wrong and will stay wrong.
        const code = Number(payload.error.code);
        if (code === 4) throw new Error(`Deezer rate limit: ${payload.error.message}`);
        return [];
      }

      const rows = [];
      const seen = new Set();
      for (const item of Array.isArray(payload?.data) ? payload.data : []) {
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
   * What Deezer says a track id refers to.
   *
   * Used to turn a `dz:` row into a title, artist and duration when the row did
   * not carry them — a row from a queue that has been sat in the player for a
   * while, or one whose search row was assembled elsewhere.
   */
  async getTrack(nativeId, signal) {
    const id = String(nativeId ?? '').trim();
    if (!/^\d+$/.test(id)) return null;

    try {
      const payload = await httpJson(`${API}/track/${encodeURIComponent(id)}`, {
        timeoutMs: 8_000,
        retries: 1,
        signal,
      });
      if (!payload?.title) return null;
      return {
        title: String(payload.title),
        artist: String(payload.artist?.name ?? ''),
        album: String(payload.album?.title ?? ''),
        duration: Number(payload.duration) > 0 ? Number(payload.duration) : null,
        isrc: String(payload.isrc ?? '') || null,
      };
    } catch {
      return null;
    }
  },

  async health() {
    try {
      const payload = await httpJson(`${API}/search?q=music&limit=1`, {
        timeoutMs: 8_000,
        retries: 0,
      });
      const n = Array.isArray(payload?.data) ? payload.data.length : 0;
      return { ok: true, detail: `catalogue only; ${n} result(s) for a probe query` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
