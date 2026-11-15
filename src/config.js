export const VERSION = '2.0.0';

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const PROXY_AUDIO = process.env.PROXY === '1';
export const TOKEN = process.env.ADDON_TOKEN ?? '';
export const MAX_ROWS = 40;
export const SEARCH_TIMEOUT_MS = 15_000;
export const MEDIA_RETRIES = 3;
export const STARTED = Date.now();

/**
 * BitChord addon auth: off | log | enforce.
 *
 * `enforce` is the default because the manifest declares `bitchordAuth`, and a
 * declared flag that nothing checks would hide the app's "Outdated addon" note
 * while making a promise this server does not keep.
 */
export const AUTH_MODE = String(process.env.BITCHORD_AUTH ?? 'off').trim().toLowerCase();

/**
 * The hostname(s) listeners paste into BitChord, comma-separated.
 *
 * The proof signs this, never the request's `Host` header, so it has to be the
 * public name: `addon.example.com`, not `https://addon.example.com/` and not
 * `addon.example.com:8787`.
 */
export const AUTH_HOSTS = String(process.env.BITCHORD_HOSTS ?? '');

/**
 * A mirror of BitChord's auth issuer, for a deployment that cannot reach
 * `bitchord-auth.kushagrasingh.in`. Unset means the issuer baked into the
 * vendored verifier, which is the normal case.
 */
export const AUTH_ISSUER = String(process.env.BITCHORD_AUTH_URL ?? '').trim();
