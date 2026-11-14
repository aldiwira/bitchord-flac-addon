import { VERSION } from './config.js';
import { ACTIVE } from './registry.js';

/**
 * The name BitChord shows in the Sources list.
 *
 * Every configured source is named, because which catalogues are live is the one
 * thing worth knowing at a glance — but the list row has a fixed width and a
 * name that overflows it is truncated by the app rather than by us. So the full
 * list is fitted within that width, and when it does not fit the sources are
 * counted instead of named: "3 sources" says what "…" does not.
 */
const LIST_ROW_LIMIT = 48;

function displayName() {
  const labels = ACTIVE.map((source) => source.label).join(' + ');
  const named = `FLAC Source · ${labels}`;
  if (named.length <= LIST_ROW_LIMIT) return named;

  const counted = `FLAC Source · ${ACTIVE.length} sources`;
  if (counted.length <= LIST_ROW_LIMIT) return counted;

  // Even the count does not fit: fall back to the invariable part.
  return 'FLAC Source';
}

export const MANIFEST = {
  id: 'dev.oreomuncher45.bitchord.flac',
  name: displayName(),
  version: VERSION,
  resources: ['search', 'stream'],
  settings: [
    {
      key: 'quality',
      type: 'select',
      default: 'lossless',
      options: [
        { label: 'Lossless (FLAC)', value: 'lossless' },
        { label: 'High', value: 'high' },
        { label: 'Low', value: 'low' },
      ],
    },
  ],
};
