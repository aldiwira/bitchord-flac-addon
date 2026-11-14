/**
 * Tidal, through Tidal's own API as streamrip drives it.
 *
 * Unlike the Monochrome-backed `tidal` source, this one talks to
 * `api.tidalhifi.com/v1` directly: it searches the catalogue, asks for a
 * playback manifest, base64-decodes it, and plays the URL inside. That is the
 * shape `streamrip/client/tidal.py` uses, and it is the only path that can
 * hand back the original CDN URL rather than a proxy's.
 *
 * Authentication is optional from this addon's point of view. When
 * `TIDAL_ACCESS_TOKEN` (or a refresh token) is configured the requests carry a
 * bearer token and refresh it as it ages; without one the requests go out
 * unauthenticated and the upstream decides, which keeps the source loadable in
 * environments that inject their own fetch.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = process.env.TIDALV2_BASE_URL || process.env.TIDAL_BASE_URL_V2 || 'https://api.tidalhifi.com/v1';
const AUTH_BASE = process.env.TIDAL_AUTH_BASE_URL || 'https://auth.tidal.com/v1/oauth2';

const CLIENT_ID = process.env.TIDAL_CLIENT_ID || 'fX2JxhdmntZWK0ixT';
const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || '1Nm5AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg=';

let accessToken = process.env.TIDAL_ACCESS_TOKEN || process.env.TIDAL_TOKEN || '';
let refreshToken = process.env.TIDAL_REFRESH_TOKEN || '';
let userId = process.env.TIDAL_USER_ID || '';
let countryCode = process.env.TIDAL_COUNTRY_CODE || 'US';
let tokenExpiry = Number(process.env.TIDAL_TOKEN_EXPIRY || 0);

const probeCache = new TtlCache(4_000);
const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

function artwork(value) {
  if (!value) return undefined;
  const str = String(value);
  if (str.startsWith('http')) return str;
  return `https://resources.tidal.com/images/${str.replace(/-/g, '/')}/640x640.jpg`;
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1000) return Math.round(n / 1000);
  return Math.round(n * 10) / 10;
}

function artistOf(item) {
  const artists = item?.artists ?? item?.artist ?? item?.artistName;
  if (Array.isArray(artists)) return artists.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ');
  if (artists && typeof artists === 'object') return String(artists.name ?? artists.title ?? '');
  return String(artists ?? '');
}

async function refreshAccessToken() {
  if (!refreshToken) refreshToken = process.env.TIDAL_REFRESH_TOKEN || '';
  if (!refreshToken) throw new Error('no refresh token configured');
  const clientId = process.env.TIDAL_CLIENT_ID || CLIENT_ID;
  const clientSecret = process.env.TIDAL_CLIENT_SECRET || CLIENT_SECRET;
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'r_usr+w_usr+w_sub',
  });
  const response = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`token refresh failed: HTTP ${response.status}`);
  const data = await response.json();
  accessToken = data?.access_token || accessToken;
  if (data?.refresh_token) refreshToken = data.refresh_token;
  tokenExpiry = (Number(data?.expires_in) || 3600) + Date.now() / 1000;
  if (data?.user?.userId) userId = String(data.user.userId);
  if (data?.user?.countryCode) countryCode = String(data.user.countryCode);
  return accessToken;
}

async function getAccessToken() {
  if (!accessToken) accessToken = process.env.TIDAL_ACCESS_TOKEN || process.env.TIDAL_TOKEN || '';
  if (!refreshToken) refreshToken = process.env.TIDAL_REFRESH_TOKEN || '';
  if (!userId) userId = process.env.TIDAL_USER_ID || '';
  if (!countryCode || countryCode === 'US') {
    const envCountry = process.env.TIDAL_COUNTRY_CODE;
    if (envCountry) countryCode = envCountry;
  }
  if (!tokenExpiry) tokenExpiry = Number(process.env.TIDAL_TOKEN_EXPIRY || 0);
  if (accessToken && tokenExpiry && tokenExpiry - Date.now() / 1000 > 60) {
    return accessToken;
  }
  if (refreshToken) {
    try {
      return await refreshAccessToken();
    } catch {
      /* fall through and try the existing token */
    }
  }
  return accessToken || null;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function decodeManifest(value) {
  const text = Buffer.from(String(value ?? ''), 'base64').toString('utf8');
  return JSON.parse(text);
}

export const tidalv2 = {
  id: 'tidalv2',
  label: 'Tidal V2',
  lossless: true,
  baseUrl: BASE,
  async ensureAuth() {
    return getAccessToken();
  },

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    return searchCache.wrap(`tidalv2:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
      const token = await getAccessToken();
      const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const params = new URLSearchParams();
      params.set('query', text);
      params.set('limit', String(capped));
      if (countryCode) params.set('countryCode', countryCode);

      const payload = await httpJson(`${BASE}/search/tracks?${params}`, {
        timeoutMs: 12_000,
        signal,
        headers: authHeaders(token),
      });

      const items = Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.tracks?.items)
          ? payload.tracks.items
          : Array.isArray(payload?.tracks)
            ? payload.tracks
            : Array.isArray(payload?.data)
              ? payload.data
              : [];
      return items
        .map((raw) => {
          const item = raw && raw.item && (raw.type === 'track' || !raw.type) ? raw.item : raw;
          const id = item?.id ?? item?.trackId ?? item?.item?.id;
          const title = String(item?.title ?? item?.name ?? '').trim();
          if (!id || !title) return null;
          return {
            id: `tidalv2:${id}`,
            title,
            artist: artistOf(item),
            album: String(item?.album?.title ?? item?.album?.name ?? item?.albumTitle ?? '').trim(),
            duration: seconds(item?.duration ?? item?.durationSeconds ?? item?.durationMs),
            artworkURL: artwork(item?.album?.cover ?? item?.album?.image ?? item?.cover ?? item?.artwork),
            format: 'flac',
            audioQuality: String(item?.audioQuality ?? 'LOSSLESS').toUpperCase(),
            _source: 'tidalv2',
            _nativeId: String(id),
          };
        })
        .filter(Boolean)
        .slice(0, capped);
    });
  },

  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!id) throw new NotFound('no track id');

    const token = await getAccessToken();
    const quality = tier === 'LOSSLESS' ? 'LOSSLESS' : tier === 'HIGH' ? 'HIGH' : tier === 'LOW' ? 'LOW' : 'LOSSLESS';

    const params = new URLSearchParams();
    params.set('audioquality', quality);
    params.set('playbackmode', 'STREAM');
    params.set('assetpresentation', 'FULL');
    if (countryCode) params.set('countryCode', countryCode);

    const payload = await httpJson(`${BASE}/tracks/${encodeURIComponent(id)}/playbackinfopostpaywall?${params}`, {
      timeoutMs: 12_000,
      signal,
      headers: authHeaders(token),
    });

    let manifest;
    try {
      manifest = decodeManifest(payload?.manifest);
    } catch {
      throw new UpstreamError('Tidal returned an unreadable manifest');
    }

    const encryptionType = String(manifest?.encryptionType ?? 'NONE').toUpperCase();
    if (encryptionType !== 'NONE') throw new NotFound('track is encrypted');

    const streamUrl = Array.isArray(manifest?.urls) ? manifest.urls[0] : manifest?.url;
    if (!streamUrl) throw new UpstreamError('Tidal returned no stream URL');

    const codecs = String(manifest?.codecs ?? '').toUpperCase();
    if (codecs && !codecs.includes('FLAC')) throw new NotFound('not a FLAC rendition');

    const probe = await this.probe(streamUrl, id, signal);

    return {
      url: streamUrl,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : null,
      channels: probe?.channels ?? null,
      probed: Boolean(probe),
      error: probe ? undefined : 'served, but the FLAC header could not be read',
    };
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(`probe:${cacheKey}`, Number.MAX_SAFE_INTEGER, async () => {
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

  mediaUrl(nativeId) {
    return `${BASE}/tracks/${encodeURIComponent(String(nativeId))}`;
  },

  async health() {
    const token = await getAccessToken();
    try {
      const params = new URLSearchParams({ query: 'music', limit: '1' });
      if (countryCode) params.set('countryCode', countryCode);
      const payload = await httpJson(`${BASE}/search/tracks?${params}`, {
        timeoutMs: 8_000,
        retries: 0,
        headers: authHeaders(token),
      });
      const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.tracks) ? payload.tracks : [];
      return { ok: true, detail: `${items.length} result(s) for a probe query` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};

export const ensureAuth = getAccessToken;
export const tidalV2 = tidalv2;
export const tidal2 = tidalv2;
export default tidalv2;
