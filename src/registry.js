import { tidal } from './lib/sources/tidal.js';
import { tidalv2 } from './lib/sources/tidalv2.js';
import { archive } from './lib/sources/archive.js';
import { netease } from './lib/sources/netease.js';
/** Only the sources named here are asked. Order is the order they are asked in. */
export const REGISTRY = new Map([
  [tidal.id, tidal],
  [tidalv2.id, tidalv2],
  [archive.id, archive],
  [netease.id, netease],
]);

export const ACTIVE = (process.env.SOURCES ?? 'tidal,netease')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => REGISTRY.has(name))
  .map((name) => REGISTRY.get(name));

if (!ACTIVE.length) {
  console.error('[addon] SOURCES named no known source. Known:', [...REGISTRY.keys()].join(', '));
  process.exit(1);
}
