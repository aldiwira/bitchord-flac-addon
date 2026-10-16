import { VERSION } from './config.js';
import { ACTIVE } from './registry.js';

export const MANIFEST = {
  id: 'dev.oreomuncher45.bitchord.flac',
  name: `FLAC Source · ${ACTIVE.map((source) => source.label).join(' + ')}`,
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
