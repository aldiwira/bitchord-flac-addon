import { tidal } from './lib/sources/tidal.js';
import { archive } from './lib/sources/archive.js';
import { netease } from './lib/sources/netease.js';
import { monochrome } from './lib/sources/monochrome.js';
import { qobuz } from './lib/sources/qobuz.js';
import { deezer } from './lib/sources/deezer.js';

/**
 * Every source this addon knows how to ask. Order is the order `/health` reports
 * them and the order the failover walk tries them in, so it is also a statement
 * of priority: the sources most likely to answer with FLAC first.
 */
export const REGISTRY = new Map([
  [tidal.id, tidal],
  [qobuz.id, qobuz],
  [monochrome.id, monochrome],
  [netease.id, netease],
  [archive.id, archive],
  // Catalogue only: no `resolve`, so a row from here fails over to the sources
  // above. Registered rather than omitted because its rows are still worth
  // emitting, and because `resolveAt` must recognise the id to walk past it.
  [deezer.id, deezer],
]);

/**
 * Id prefixes this addon answers to, and the source each belongs to.
 *
 * The aliases exist because the same catalogues were addressed by shorter
 * prefixes in an earlier deployment, and a row issued then is still sitting in a
 * queue on someone's phone. `qb:` and `dz:` rather than `qobuz:`/`deezer:` are
 * the ones that differ from this file's own ids; `mc:` predates `monochrome:`.
 *
 * `nt:` is the short form for NetEase. The NeteaseCloudMusicApi source this
 * addon used to ship issued plain `netease:` ids for the same NetEase song ids
 * Meting resolves, so rows from that deployment keep resolving here instead of
 * turning into a 404.
 *
 * Deliberately not folded into `REGISTRY`: two keys would then name one source,
 * and `/health` would report it twice.
 */
export const ALIASES = new Map([
  ['qb', qobuz.id],
  ['mc', monochrome.id],
  ['dz', deezer.id],
  ['nt', netease.id],
]);

/**
 * The sources actually asked, in the order `SOURCES` names them.
 *
 * An unknown name is reported rather than dropped silently: a `SOURCES` list
 * that names nothing this build has is a deployment mistake, and a config that
 * quietly degrades to a subset is how that mistake survives. It is a warning
 * rather than a failure, because the sources that *are* known are still usable.
 */
const requested = (process.env.SOURCES ?? 'qobuz,monochrome,netease,tidal,archive')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

const known = requested.filter((name) => REGISTRY.has(name));
const unknown = requested.filter((name) => !REGISTRY.has(name));

if (unknown.length) {
  console.warn(
    `[addon] SOURCES named unknown source(s): ${unknown.join(', ')}. ` +
      `Known: ${[...REGISTRY.keys()].join(', ')}`,
  );
}

export const ACTIVE = known.map((name) => REGISTRY.get(name));

if (!ACTIVE.length) {
  console.error(
    '[addon] SOURCES named no usable source. Known:',
    [...REGISTRY.keys()].join(', '),
  );
  process.exit(1);
}
