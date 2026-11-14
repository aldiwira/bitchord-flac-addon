import { settleAll, parseTier } from '../lib/http.js';
import { carryRowId } from '../lib/failover.js';
import { ACTIVE } from '../registry.js';
import { MAX_ROWS, SEARCH_TIMEOUT_MS } from '../config.js';
import { json, log } from '../utils/response.js';

/**
 * One search across every active source.
 *
 * A query that one source answers and another does not is the normal case, not
 * an error, and the rows from both are returned in the order the sources were
 * configured — the first source's best match leading, because it is the one the
 * operator put first.
 */
export async function search(query, limit, signal) {
  const results = await settleAll(
    ACTIVE.map(
      (source) => async () => ({ source, rows: await source.search(query, limit, signal) }),
    ),
    ACTIVE.length,
  );

  const rows = [];
  const failures = [];
  for (const entry of results) {
    if (entry.ok) {
      rows.push(...entry.value.rows);
    } else {
      failures.push({ source: entry.value?.source?.id ?? '?', error: entry.error?.message });
    }
  }

  // De-duplicate exact duplicate ids, keeping the earliest occurrence. A row
  // from two different catalogues has a different id, so it is kept; only a
  // source that returns the same id twice is collapsed here.
  const seen = new Set();
  const unique = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return { rows: unique.slice(0, limit), failures };
}

/**
 * Reduces a row to the wire shape BitChord reads.
 *
 * Only fields from `AddonTrack` are emitted. Everything prefixed `_` is a
 * source's own bookkeeping and is dropped here: it is this addon's internal
 * handle, not something BitChord can use.
 *
 * The `id` is the one field that is not the source's. BitChord puts it into
 * `/stream/{id}` as the only thing this addon will receive back, and `/stream`
 * needs the title, artist and duration to fail over to another catalogue — so
 * they travel inside the id. See `lib/failover.js` for why that container is the
 * cheapest place to put them.
 */
export function wireRow(row) {
  return {
    id: carryRowId(row),
    title: row.title,
    artist: row.artist ?? '',
    album: row.album ?? '',
    duration: row.duration ?? undefined,
    artworkURL: row.artworkURL ?? undefined,
    albumArtworkURL: row.albumArtworkURL ?? undefined,
    format: row.format ?? 'flac',
    audioQuality: row.audioQuality ?? 'LOSSLESS',
  };
}

export async function handleSearch(req, res, url) {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return json(res, 200, { tracks: [] });

  const tier = parseTier(url.searchParams.get('quality'));
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || MAX_ROWS, 1),
    MAX_ROWS,
  );

  const started = Date.now();
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let outcome;
  try {
    outcome = await search(query, limit, deadline);
  } catch (error) {
    log('error', 'search threw', { query, error: error.message });
    return json(res, 502, {
      error: 'UPSTREAM_UNAVAILABLE',
      message: 'every source failed',
    });
  }

  if (outcome.failures.length) {
    log('warn', 'partial search', {
      query,
      tier,
      failed: outcome.failures,
      rows: outcome.rows.length,
    });
  }

  log('info', 'search', {
    query,
    tier,
    rows: outcome.rows.length,
    ms: Date.now() - started,
  });

  return json(res, 200, { tracks: outcome.rows.map(wireRow) });
}
