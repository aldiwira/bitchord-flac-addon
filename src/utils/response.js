import { PORT } from '../config.js';

export function tokenOk(provided, TOKEN) {
  if (!TOKEN) return true;
  if (typeof provided !== 'string' || provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

export function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function notFound(res, message) {
  json(res, 404, { error: 'NOT_FOUND', message });
}

export async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 512 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function log(level, message, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg: message, ...fields };
  console.log(JSON.stringify(line));
}

export function publicOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]
    || 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
    || req.headers.host
    || `localhost:${PORT}`;
  return `${proto}://${host}`;
}
