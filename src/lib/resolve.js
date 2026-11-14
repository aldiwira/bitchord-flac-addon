/**
 * Row ids to playable streams.
 *
 * The two routes that need this — `/stream/{id}` and `/media/{id}.flac` — differ
 * only in whether this addon proxies the bytes. Both take an id BitChord echoed
 * back from `/search`, so both do the identical work: unwrap it, resolve it at
 * the catalogue that issued it, and fail over when that catalogue cannot serve
 * it. Keeping that in one module is what stops the proxy route from drifting
 * into a second, subtly different definition of what an id means.
 */

import { NotFound } from './http.js';
import { parseTrackId } from './trackid.js';
import { parseCarryId, failover } from './failover.js';
import { archive, parseArchiveId } from './sources/archive.js';
import { REGISTRY, ALIASES } from '../registry.js';

/**
 * Resolves one of this addon's row ids at one named source.
 *
 * Takes a whole row id rather than a native handle, because two of the sources
 * need more than a handle: the Archive's id carries the item `identifier` beside
 * the filename, and that identifier exists nowhere else. Splitting it here keeps
 * every caller — the direct path and the failover walk — on one code path, so a
 * source that gains a second id component later gains it in one place.
 *
 * A catalogue-only source has no `resolve` because it has no audio. That is a
 * miss at that source and not a failure: it is exactly the case failover exists
 * to walk past, and throwing `NotFound` is how this says so.
 *
 * @param {object} source an entry from `REGISTRY`
 * @param {string} rowId an id this addon issued
 * @param {string} tier BitChord's normalised tier
 * @param {AbortSignal} signal the request's deadline
 */
export async function resolveAt(source, rowId, tier, signal) {
  const parsed = parseTrackId(rowId);
  if (!parsed) throw new NotFound('not an id this addon issued');
  if (typeof source.resolve !== 'function') {
    throw new NotFound(`${source.label ?? source.id} is a catalogue and holds no audio`);
  }

  if (source === archive) {
    const parts = parseArchiveId(rowId);
    if (!parts) throw new NotFound('malformed archive id');
    return source.resolve(parts.filename, tier, parts, signal);
  }

  return source.resolve(parsed.nativeId, tier, signal);
}

/**
 * Resolves one wire id to something playable, failing over when needed.
 *
 * @param {string} id the id BitChord echoed back from a `/search` row
 * @param {string} tier BitChord's normalised tier
 * @param {AbortSignal} signal the request's deadline
 * @returns {Promise<{source: string, rowId: string, result: object}>}
 */
export async function resolve(id, tier, signal) {
  const carried = parseCarryId(id);
  if (!carried) throw new NotFound('not an id this addon issued');

  // An id may name a source this process is not configured to ask — a stale row
  // from a deployment with a different `SOURCES`. That is a miss at that source,
  // which failover treats like any other and walks past, rather than a 404 for a
  // recording another active source may well hold.
  const known = REGISTRY.has(carried.source);

  return failover({ ...carried, known }, tier, signal, { resolveAt });
}
