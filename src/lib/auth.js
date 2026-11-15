/**
 * BitChord addon auth: accepting only the official app.
 *
 * The manifest declares `bitchordAuth: true`, and from then on every route but
 * `/manifest.json` requires the two headers the app attaches — a token from
 * BitChord's auth service and a proof signed by a key in the phone's secure
 * hardware. Verification is local against cached Ed25519 public keys, so it
 * costs a request nothing.
 *
 * ## Why this exists here
 *
 * Not to lock the addon down for its own sake. BitChord shows **"Outdated
 * addon"** on any addon whose manifest does not declare `bitchordAuth`, and the
 * flag is only honourable together with a check: declaring it and serving
 * everybody anyway would hide the warning while making the promise false. The
 * two are one feature, so they land together.
 *
 * ## Three modes
 *
 *   off     `BITCHORD_AUTH=off` — no flag, no check. The app shows the outdated
 *           note; everything works. The escape hatch for a deployment that needs
 *           desktop or web clients.
 *   log     `BITCHORD_AUTH=log` — the flag is declared and credentials are
 *           verified, but a failure is logged and the request is still served.
 *           The rollout step the docs describe: watch for `invalid_proof`
 *           before refusing anyone.
 *   enforce `BITCHORD_AUTH=enforce` — default. A request without valid
 *           credentials is refused with the `WWW-Authenticate: BitChord` header
 *           the app reads.
 *
 * The manifest stays public in all three: the app reads it to learn whether it
 * has to authenticate at all.
 *
 * ## Hosts are required, and are not the `Host` header
 *
 * The proof signs the hostname from the addon URL the listener pasted. This
 * module never trusts `Host`; it verifies against the list in `BITCHORD_HOSTS`
 * and refuses to start enforcing without one, because a wrong or absent list
 * makes every request fail `invalid_proof` — a broken addon that looks healthy.
 */

import { createBitChordAuth } from '../../vendor/bitchord-addon-auth.mjs';
import { AUTH_ISSUER } from '../config.js';
import { log } from '../utils/response.js';

/**
 * Lowercase, no scheme, port or path — what the app signs.
 *
 * IPv6 needs care: `[::1]:8787` and a bare `::1` are the same host, and the
 * naive `/:\d+$/` strip turns the latter into `:`. A bracketed literal has its
 * port removed with the brackets; an unbracketed one has no port at all.
 */
export function normalizeHost(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '');

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) return bracketed[1];

  // More than one colon and no brackets means an IPv6 literal, not a port.
  if ((text.match(/:/g) ?? []).length > 1) return text;
  return text.replace(/:\d+$/, '');
}

/** `BITCHORD_HOSTS` as a list, comma- or space-separated. */
export function parseHosts(value) {
  return [...new Set(String(value ?? '')
    .split(/[,\s]+/)
    .map(normalizeHost)
    .filter(Boolean))];
}

const MODES = new Set(['off', 'log', 'enforce']);

/**
 * Builds the guard from the environment.
 *
 * @param {{mode?: string, hosts?: string[], issuer?: string}} [opts]
 * @returns {{mode: 'off'|'log'|'enforce', declares: boolean,
 *            check: (req: import('node:http').IncomingMessage) => Promise<
 *              {ok: true} | {ok: false, status: number, headers: object, body: string}>}}
 */
export function createAuth(opts = {}) {
  const requested = String(opts.mode ?? '').trim().toLowerCase();
  const mode = MODES.has(requested) ? requested : 'enforce';
  const hosts = opts.hosts ?? [];

  if (mode === 'off') {
    return { mode, declares: false, check: async () => ({ ok: true }) };
  }

  if (!hosts.length) {
    // Log-only has a defensible reading of an empty list — verify nothing,
    // refuse nothing — but enforcement cannot work, so it must not pretend to.
    if (mode === 'enforce') {
      throw new Error(
        'BITCHORD_AUTH=enforce needs BITCHORD_HOSTS: the hostname(s) listeners paste ' +
          '(no https://, no port). Without it every request fails invalid_proof.',
      );
    }
    log('warn', 'bitchord auth: no BITCHORD_HOSTS, verification cannot succeed', { mode });
    return { mode, declares: true, check: async () => ({ ok: true }) };
  }

  // The issuer is baked into the vendored verifier. Overriding it is only for a
  // mirror, and it is passed explicitly rather than read inside that file so the
  // vendored copy stays byte-identical to the reference.
  const verifier = createBitChordAuth({ hosts, ...(AUTH_ISSUER ? { issuer: AUTH_ISSUER } : {}) });

  return {
    mode,
    declares: true,
    async check(req) {
      let result;
      try {
        result = await verifier.verifyRequest(req);
      } catch (error) {
        // Key fetch failed and nothing was cached: the app treats 503 as an
        // outage and retries, which is the honest answer.
        return {
          ok: false,
          error: 'unavailable',
          ...verifier.rejection({
            status: 503,
            error: 'unavailable',
            message: error.message ?? 'could not load BitChord signing keys',
          }),
        };
      }
      if (result.ok) return { ok: true, claims: result.claims };
      // `error` is carried beside the wire response: the header and body are
      // what the app reads, this is what the log needs to name the reason.
      return { ok: false, error: result.error, ...verifier.rejection(result) };
    },
  };
}
