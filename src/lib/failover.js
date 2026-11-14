/**
 * Cross-source failover: resolving a row the source that issued it cannot play.
 *
 * A row's id names the catalogue that produced it, and `/stream` honours that
 * name first. When that catalogue does not hold a playable rendition — a Tidal
 * row for a track Monochrome's index has metadata for but no file behind it, a
 * NetEase row whose region check came back empty — the row is still *correct*,
 * and the recording it describes almost certainly exists somewhere else.
 *
 * So the row is re-matched against the other catalogues instead of being dropped.
 * BitChord's own fallback drops it: a 404 moves on to the next *source*, and when
 * this addon is the only one installed there is nothing to move on to. Failing
 * over here is the difference between one playable track and none.
 *
 * ## Where the metadata comes from
 *
 * `/stream` receives an id and nothing else, so the title, artist and duration
 * that a re-match needs have to travel inside it. That is the one design
 * consequence worth stating plainly: **the wire id is a container, not a
 * pointer.** It is still opaque to BitChord — which is all BitChord requires —
 * and it makes a cold `/stream` behave exactly like a warm one, after a restart
 * or from a second process, with nothing remembered between requests.
 *
 * The wrap happens at the wire boundary only (`wireRow` in the search handler).
 * Each source's own id keeps its readable form, because that readable form is
 * what appears in this addon's logs — `tidal:154049681742106624` in a log line
 * is worth the extra field here, and `parseCarryId` hands it back untouched.
 */

import { ACTIVE, ALIASES } from '../registry.js';
import { NotFound, TtlCache } from './http.js';
import { makeTrackId, parseTrackId } from './trackid.js';

/**
 * The source a wire id names, honouring the legacy prefixes.
 *
 * An earlier deployment addressed Qobuz as `qb:`, Monochrome as `mc:` and Deezer
 * as `dz:`. Rows issued then are still in queues, and an id is the only thing
 * `/stream` receives, so the alias has to be understood here rather than fixed
 * up at the edge. Canonical ids are returned unchanged.
 */
function sourceOf(value) {
  return ALIASES.get(value) ?? value;
}

/**
 * Version marker for the payload, so an id issued under an older scheme (or
 * hand-written) is recognised and refused rather than parsed as garbage.
 */
const CARRY_VERSION = 1;

/**
 * The JSON carried in the id, encoded by `makeTrackId` into one path-safe part.
 *
 * Single-letter keys because this string is a URL path segment on every stream
 * request, and `d` is the duration in whole seconds — a failover compares
 * durations, so sub-second precision is noise that costs bytes.
 *
 * Album is deliberately absent. It is the field most likely to differ between
 * two catalogues for the identical recording (deluxe editions, regional
 * pressings, compilation renames), so carrying it would only equip `pickMatch`
 * to reject matches it should accept.
 */
function payloadOf(row) {
  return {
    v: CARRY_VERSION,
    r: String(row.id ?? ''),
    t: String(row.title ?? '').trim(),
    a: String(row.artist ?? '').trim(),
    d: Number.isFinite(row.duration) && row.duration > 0 ? Math.round(row.duration) : null,
  };
}

/**
 * The id BitChord will hold for one search row.
 *
 * @param {object} row a source's own row, in BitChord's `tracks` shape
 * @returns {string}
 */
export function carryRowId(row) {
  const payload = payloadOf(row);
  // A legacy id is re-minted canonically: the alias is understood once here, so
  // nothing downstream has to know the older prefixes existed.
  const legacy = parseTrackId(payload.r);
  if (legacy) {
    const canonical = sourceOf(legacy.source);
    if (canonical !== legacy.source) {
      payload.r = makeTrackId(canonical, legacy.nativeId);
    }
  }
  const source = parseTrackId(payload.r)?.source ?? '';
  // Not a source's id: hand it back untouched rather than inventing a source
  // name for it. `parseCarryId` will refuse it and the route answers a miss,
  // which is the same outcome, without a malformed container on the wire.
  if (!source || !payload.t) return payload.r;
  return makeTrackId(source, JSON.stringify(payload));
}

/**
 * Reads a row back out of a carried id.
 *
 * Returns null for anything this addon did not issue, which the routes treat as
 * a miss: BitChord only ever echoes back ids it was given, so an unrecognised one
 * is a stale row rather than a client error.
 *
 * @param {string} id
 * @returns {{source: string, rowId: string, title: string, artist: string,
 *            duration: number|null}|null}
 */
export function parseCarryId(id) {
  const parsed = parseTrackId(id);
  if (!parsed) return null;

  let payload;
  try {
    payload = JSON.parse(parsed.nativeId);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || payload.v !== CARRY_VERSION) return null;
  if (typeof payload.r !== 'string' || !payload.r) return null;
  if (typeof payload.t !== 'string' || !payload.t.trim()) return null;

  const inner = parseTrackId(payload.r);
  if (!inner) return null;

  return {
    source: sourceOf(inner.source),
    rowId: payload.r,
    title: payload.t.trim(),
    artist: typeof payload.a === 'string' ? payload.a.trim() : '',
    duration: Number.isFinite(payload.d) && payload.d > 0 ? payload.d : null,
  };
}

/**
 * Normalises a title or artist for comparison.
 *
 * Accents are folded rather than stripped, because "Björk" and "Bjork" are the
 * same artist and real catalogues serve both.
 *
 * Bracketed text is dropped only when it names a *release*, because that is an
 * property of an edition rather than of a recording: "(Remastered 2011)",
 * "[Deluxe Edition]" and "(Mono)" are the same performance. The list is
 * deliberately closed. Stripping every parenthetical would also collapse
 * "One More Time" into "One More Time (Live)", which is a different performance
 * and must not be served in place of the studio one.
 */
const RELEASE_QUALIFIER =
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|deluxe|edition|version|anniversary|bonus|re-?issue|explicit|mono|stereo|remix|remixes)\b[^)\]]*[)\]]/gi;

export function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(RELEASE_QUALIFIER, ' ')
    .replace(/\b(feat|ft|featuring|with|prod)\b.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when the two artist strings name at least one of the same artists.
 *
 * Catalogue artist strings are lists in no fixed order and no fixed spelling:
 * "Timbaland, Justin Timberlake" against "Justin Timberlake, Timbaland", and a
 * "Last, First" credit that the rest of the world writes as "First Last". Both
 * are the same recording.
 */
export function artistsOverlap(a, b) {
  const parts = (value) =>
    String(value ?? '')
      .split(/\s*(?:,|;|&|\bfeat\.?\b|\bft\.?\b|\band\b|\bx\b)\s*/i)
      .map(norm)
      .filter((part) => part.length > 2);

  const left = parts(a);
  const right = parts(b);
  if (!left.length || !right.length) return false;
  if (left.includes(right[0]) || right.includes(left[0])) return true;

  // "Davis, Miles" against "Miles Davis". A written credit is a single name that
  // the comma split cut in two, so the comparison has to be between whole
  // normalised names in both orders, not between the comma-separated fragments.
  const reversed = (name) => name.split(' ').reverse().join(' ');
  const whole = (value) => norm(value);
  const [wa, wb] = [whole(a), whole(b)];
  if (wa && wb && (wa === wb || reversed(wa) === wb)) return true;

  return left.some((x) => right.some((y) => x === y || reversed(x) === reversed(y)));
}

/**
 * The row of `rows` that is the same recording as `meta`, or null.
 *
 * Exact title equality is required. A fuzzy title match across catalogues is how
 * a live version gets served for a studio one, and that is worse than a miss: a
 * miss is a track that does not play, a wrong match is a track that plays the
 * wrong thing. Duration is the only field allowed to be inexact, within a
 * tolerance that admits a different mastering of the same edit and refuses a
 * different performance.
 *
 * @param {Array} rows
 * @param {{title: string, artist: string, duration: number|null}} meta
 * @returns {object|null}
 */
export function pickMatch(rows, meta) {
  const wanted = norm(meta.title);
  if (!wanted) return null;

  let best = null;
  let bestScore = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id || norm(row.title) !== wanted) continue;
    if (!artistsOverlap(row.artist, meta.artist)) continue;

    let score = 60;
    if (meta.duration && row.duration) {
      const drift = Math.abs(Number(row.duration) - meta.duration);
      if (drift <= 3) score += 40;
      else if (drift <= 10) score += 20;
      else if (drift <= 45) score += 8;
      else continue;
    } else {
      // One side stated no duration. Neutral, rather than punished for silence.
      score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return best;
}

/**
 * Matches are cached; stream URLs are not.
 *
 * The same split the sources make internally, and for the same reason: a
 * catalogue's answer to a query is close to immutable, while every stream URL is
 * freshly signed and a stale one is a track that fails to start. Failover only
 * ever caches the rows it matched.
 */
const matchCache = new TtlCache(4_000);
const MATCH_TTL_MS = 5 * 60 * 1000;

/**
 * Forgets every cached match.
 *
 * Exposed because a match cache is a claim about the world that can go stale in
 * a way a stream cache cannot: a catalogue that gains a recording should be
 * found by the next failover, not in five minutes. Also the seam a test needs to
 * run the same scenario twice.
 */
export function clearMatchCache() {
  matchCache.clear();
}

/** How many rows a candidate's search is allowed to return before matching. */
const CANDIDATE_ROWS = 20;

/**
 * Resolves `carried` at the catalogue that issued it, then at every other active one.
 *
 * Candidates are searched in parallel — that is what a search does everywhere
 * else in this addon, and one slow catalogue must not be able to hold up an
 * answer the others can give. The *resolutions* are sequential, because each is a
 * stream URL that upstream rate-limits and only the first success is wanted.
 *
 * The source that issued the id is always tried first and is never retried as a
 * candidate: it has already said no.
 *
 * @param {object} carried what `parseCarryId` returned, plus `known`: whether
 *        this process is configured to ask the issuing source at all. A stale row
 *        from a deployment with a different `SOURCES` names a source that is not
 *        here, and that is a miss like any other rather than a 404 for a
 *        recording another active source may well hold.
 * @param {string} tier BitChord's normalised tier
 * @param {AbortSignal} signal the request's deadline
 * @param {{resolveAt: (source: object, rowId: string, tier: string, signal: AbortSignal) => Promise<object>,
 *          searchAt?: (source: object, query: string, limit: number, signal: AbortSignal) => Promise<Array>,
 *          sources?: Array<object>}} port
 *        what this needs from the outside world, injected so the walk is testable
 *        without a network and so the caller owns the id parsing
 * @returns {Promise<{source: string, issuer: string, rowId: string, result: object}>}
 */
export async function failover(carried, tier, signal, port) {
  const {
    resolveAt,
    searchAt = (source, query, limit, sig) => source.search(query, limit, sig),
    sources = ACTIVE,
  } = port;

  const first = carried.known === false
    ? undefined
    : sources.find((source) => source.id === carried.source);

  if (first) {
    try {
      return {
        source: first.id,
        issuer: carried.source,
        rowId: carried.rowId,
        result: await resolveAt(first, carried.rowId, tier, signal),
      };
    } catch (error) {
      // A miss is the normal way into failover. A broken upstream is also worth
      // the walk: a catalogue that is down for this request is down for a reason
      // that says nothing about whether the recording exists elsewhere.
      if (!(error instanceof NotFound)) {
        error.failedOverFrom = first.id;
      }
    }
  }

  const query = `${carried.artist} ${carried.title}`.trim();
  const cacheKey =
    `failover:${norm(carried.artist)}|${norm(carried.title)}|${carried.duration ?? ''}`;

  let matches = matchCache.get(cacheKey);
  if (matches === undefined) {
    const candidates = sources.filter((source) => source.id !== carried.source);
    const settled = await Promise.allSettled(
      candidates.map(async (source) => ({
        source,
        rows: await searchAt(source, query, CANDIDATE_ROWS, signal),
      })),
    );

    // A candidate whose search failed did not report "no match", it reported
    // nothing. Caching that as a match set would make a throttle look like a
    // catalogue that lacks the recording, for five minutes.
    const throttled = settled.some(
      (entry) => entry.status === 'rejected' &&
        (entry.reason?.status === 429 || entry.reason?.status >= 500),
    );

    matches = settled
      .filter((entry) => entry.status === 'fulfilled')
      .map((entry) => entry.value)
      .map(({ source, rows }) => ({ source, row: pickMatch(rows, carried) }))
      .filter((match) => match.row);

    if (!throttled) matchCache.set(cacheKey, matches, MATCH_TTL_MS);
  }

  // A candidate that was merely unavailable, rather than one that was asked and
  // said no. Carried to the end so the answer is "try again" rather than "this
  // addon does not have it", which are different things to tell a player.
  let unavailable;

  for (const { source, row } of matches) {
    if (signal?.aborted) break;
    try {
      return {
        source: source.id,
        issuer: carried.source,
        rowId: row.id,
        result: await resolveAt(source, row.id, tier, signal),
      };
    } catch (error) {
      // A miss means the next candidate may hold the recording, so the walk
      // continues. Anything else — a rate limit, a reset — is remembered and the
      // walk continues too, because the next source may not share the problem.
      if (!(error instanceof NotFound)) {
        unavailable ??= error;
      }
      continue;
    }
  }

  // Every candidate that matched was unavailable. Reporting that as `NotFound`
  // would be a lie that costs the track: BitChord treats a 404 as "this addon
  // does not have it" and moves on, when the truth is "not right now".
  if (unavailable) throw unavailable;

  throw new NotFound('no source in this addon holds a playable rendition');
}
