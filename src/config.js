export const VERSION = '1.0.0';
export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const PROXY_AUDIO = process.env.PROXY === '1';
export const TOKEN = process.env.ADDON_TOKEN ?? '';
export const MAX_ROWS = 40;
export const SEARCH_TIMEOUT_MS = 15_000;
export const MEDIA_RETRIES = 3;
export const STARTED = Date.now();
