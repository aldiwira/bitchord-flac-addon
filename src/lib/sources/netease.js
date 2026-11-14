/**
 * NetEase Cloud Music, through a NeteaseCloudMusicApi instance.
 *
 * Anonymous search is useful and anonymous playback is not FLAC: the player
 * endpoint answers with MP3 or AAC and says so in its own `type` field, which
 * this source reports rather than dressing up as lossless. A self-hosted API
 * instance with a VIP cookie can return FLAC, and then the same STREAMINFO
 * probe the other sources use reports the real sample rate and bit depth.
 *
 * The signing and anonymous-token dance lives in the API service, so this file
 * adds an HTTP client and no crypto dependency.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = process.env.NETEASE_API_BASE || 'https://ncmapi.bixygames.com';

const probeCache = new TtlCache(4_000);
const searchCache = new TtlCache(2_000);
const urlCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;
const URL_TTL_MS = 5 * 60 * 1000;

const LEVELS = { LOSSLESS: 'lossless', HIGH: 'exhigh', LOW: 'standard' };

/**
 * The client IP NetEase is told the request came from.
 *
 * The public API instance is hosted outside mainland China, and NetEase answers
 * most tracks with `code 404` when the request looks overseas. Supplying a
 * mainland/private address restores them; set `NETEASE_REAL_IP` to override, or
 * to an empty string to send nothing and accept the region restriction.
 */
const REAL_IP = String(process.env.NETEASE_REAL_IP ?? '127.0.0.1').trim();

/** Upgrades the plain-HTTP URLs NetEase hands out so a phone does not refuse them. */
export function httpsUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.replace(/^http:\/\//i, 'https://');
}

/** NetEase reports milliseconds; BitChord wants seconds. */
export function seconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / 100) / 10;
}

/** Trusts the declared codec first, then the URL extension, then NetEase's default. */
export function normalizeCodec(type, url) {
  const known = ['flac', 'mp3', 'aac', 'm4a', 'opus', 'ogg'];
  const declared = String(type ?? '').trim().toLowerCase();
  if (known.includes(declared)) return declared;
  try {
    const ext = new URL(String(url ?? '')).pathname.split('.').pop()?.toLowerCase();
    if (known.includes(ext)) return ext;
  } catch {
    /* not a URL; fall through to the NetEase default */
  }
  return 'mp3';
}

/** One search row, or null when the item has no id or title to show. */
export function mapSong(song) {
  const id = song?.id ?? song?.songId;
  const title = String(song?.name ?? '').trim();
  if (!id || !title) return null;

  const artists = Array.isArray(song?.ar)
    ? song.ar
    : Array.isArray(song?.artists)
      ? song.artists
      : [];

  return {
    id: `netease:${id}`,
    title,
    artist: artists.map((a) => String(a?.name ?? '').trim()).filter(Boolean).join(', '),
    album: String(song?.al?.name ?? song?.album?.name ?? '').trim(),
    duration: seconds(song?.dt ?? song?.duration),
    artworkURL: httpsUrl(song?.al?.picUrl ?? song?.album?.picUrl),
    format: 'mp3',
    audioQuality: 'HIGH',
    _source: 'netease',
    _nativeId: String(id),
  };
}

export const netease = {
  id: 'netease',
  label: 'NetEase',
  lossless: false,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    return searchCache.wrap(`netease:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
      const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const url = `${BASE}/cloudsearch?keywords=${encodeURIComponent(text)}` +
        `&type=1&limit=${capped}`;
      const payload = await httpJson(url, { timeoutMs: 12_000, signal });
      const songs = Array.isArray(payload?.result?.songs) ? payload.result.songs : [];
      return songs.map(mapSong).filter(Boolean).slice(0, capped);
    });
  },

  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!id) throw new NotFound('no track id');

    const level = LEVELS[tier] ?? 'lossless';
    return urlCache.wrap(`netease:url:${id}:${level}`, URL_TTL_MS, async () => {
      const url = `${BASE}/song/url/v1?id=${encodeURIComponent(id)}` +
        `&level=${encodeURIComponent(level)}` +
        (REAL_IP ? `&realIP=${encodeURIComponent(REAL_IP)}` : '');
      const payload = await httpJson(url, { timeoutMs: 12_000, signal });
      const item = Array.isArray(payload?.data) ? payload.data[0] : null;

      if (!item?.url) {
        const code = item?.code ?? payload?.code;
        const message = `NetEase returned no playable URL${code ? ` (code ${code})` : ''}`;
        if (Number(code) === -460) {
          throw new UpstreamError(message, { status: 502, retryable: false });
        }
        throw new NotFound(message);
      }

      const streamUrl = httpsUrl(item.url);
      const codec = normalizeCodec(item.type, streamUrl);
      const bitrate = Number(item.br) > 0 ? Math.round(Number(item.br) / 1000) : null;

      if (codec !== 'flac') {
        return {
          url: streamUrl,
          codec,
          container: codec,
          manifest: 'none',
          encrypted: false,
          sampleRate: null,
          bitDepth: null,
          bitrate,
          channels: null,
          probed: false,
        };
      }

      const probe = await this.probe(streamUrl, id, signal);
      return {
        url: streamUrl,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        encrypted: false,
        sampleRate: probe?.sampleRate ?? null,
        bitDepth: probe?.bitDepth ?? null,
        bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : bitrate,
        channels: probe?.channels ?? null,
        probed: Boolean(probe),
        error: probe ? undefined : 'served, but the FLAC header could not be read',
      };
    });
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(`netease:probe:${cacheKey}`, Number.MAX_SAFE_INTEGER, async () => {
      let response;
      try {
        response = await httpGet(url, {
          timeoutMs: 12_000,
          retries: 1,
          range: `bytes=0-${STREAMINFO_BYTES - 1}`,
          signal,
        });
      } catch {
        return null;
      }
      const head = Buffer.from(await response.arrayBuffer());
      const info = parseFlacStreamInfo(head);
      if (!info) return null;
      const contentRange = response.headers.get('content-range') ?? '';
      const slash = contentRange.lastIndexOf('/');
      const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;
      return {
        ...info,
        byteLength: Number.isFinite(total) && total > 0 ? total : null,
      };
    });
  },

  async health() {
    try {
      const payload = await httpJson(
        `${BASE}/cloudsearch?keywords=music&type=1&limit=1`,
        { timeoutMs: 8_000, retries: 0 },
      );
      const n = Array.isArray(payload?.result?.songs) ? payload.result.songs.length : 0;
      return { ok: true, detail: `${n} result(s) for a probe query` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
