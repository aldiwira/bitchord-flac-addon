import { json } from '../utils/response.js';
import { VERSION, STARTED } from '../config.js';
import { ACTIVE } from '../registry.js';

export async function handleHealth(req, res) {
  const sources = await Promise.all(
    ACTIVE.map(async (source) => ({
      id: source.id,
      label: source.label,
    })),
  );

  return json(res, 200, {
    addon: `FLAC Source · ${ACTIVE.map((source) => source.label).join(' + ')}`,
    version: VERSION,
    protocol: 'bitchord-addon',
    routes: ['/manifest.json', '/search', '/stream/{id}'],
    optionalRoutes: process.env.PROXY === '1' ? ['/media/{id}.flac'] : ['/media/{id}.flac (PROXY=0)'],
    proxyAudio: process.env.PROXY === '1',
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    sources,
  });
}
