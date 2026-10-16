import { tidal } from '../lib/sources/tidal.js';
import { archive } from '../lib/sources/archive.js';

/** Only the sources named here are asked. Order is the order they are asked in. */
export const REGISTRY = new Map([
  [tidal.id, tidal],
  [archive.id, archive],
]);

export const ACTIVE = (process.env.SOURCES ?? 'tidal,archive')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => REGISTRY.has(name))
  .map((name) => REGISTRY.get(name));

if (!ACTIVE.length) {
  console.error('[addon] SOURCES named no known source. Known:', [...REGISTRY.keys()].join(', '));
  process.exit(1);
}