#!/usr/bin/env node
/**
 * Obtain Tidal access/refresh tokens via the device authorization flow.
 *
 * Usage: node src/scripts/tidal-login.js
 * Then export the printed values (or paste into .env).
 */
const CLIENT_ID = process.env.TIDAL_CLIENT_ID || '7m7Ap0JC9j1cOM3n';
const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || 'vRAdA108tlvkJpTsGZS8rGZ7xTlbJ0qaZ2K9saEzsgY=';
const AUTH_BASE = process.env.TIDAL_AUTH_BASE_URL || 'https://auth.tidal.com/v1/oauth2';
const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function post(url, data, useBasic = false) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (useBasic) headers.Authorization = `Basic ${basic}`;
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(data).toString() });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text}`);
  return json;
}

const device = await post(`${AUTH_BASE}/device_authorization`, {
  client_id: CLIENT_ID,
  scope: 'r_usr+w_usr+w_sub',
});
console.log('Open this URL in your browser and log in:');
console.log(device.verificationUriComplete || device.verification_uri_complete);
console.log('Waiting for authorization...');

const deviceCode = device.deviceCode || device.device_code;
let tokens = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    tokens = await post(`${AUTH_BASE}/token`, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      scope: 'r_usr+w_usr+w_sub',
    }, true);
    break;
  } catch (error) {
    const msg = String(error.message || '');
    if (msg.includes('authorization_pending') || msg.includes('slow_down')) continue;
    throw error;
  }
}
if (!tokens) throw new Error('timed out waiting for authorization');

console.log('\nAdd these to your environment / .env:');
console.log(`TIDAL_ACCESS_TOKEN=${tokens.access_token}`);
console.log(`TIDAL_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log(`TIDAL_USER_ID=${tokens.user?.userId ?? ''}`);
console.log(`TIDAL_COUNTRY_CODE=${tokens.user?.countryCode ?? 'US'}`);
console.log(`TIDAL_TOKEN_EXPIRY=${Math.floor(Date.now() / 1000) + (tokens.expires_in || 0)}`);
