/**
 * What this addon tells BitChord about itself.
 *
 * Only fields the app actually reads:
 *
 *   id, name, version, resources   `AddonManifest`, and `name` is the display name
 *   allowDownloads                 whether a download may take a stream from here
 *   settings                       read for its *defaults* and, for `quality`,
 *                                  for the picker it draws
 *
 * Everything else a manifest could carry is ignored. `description` in particular
 * is not in the schema — an addon that sends one is sending a field the app
 * discards — so it is not sent. `checkValidLossless` is absent on purpose: this
 * addon serves lossless honestly, and gating whether the phone may ask at all is
 * the listener's decision, not this manifest's.
 *
 * `bitchordAuth` is declared in `enforce` mode and absent in `off`. BitChord
 * shows **"Outdated addon"** on every addon that does not declare it, so an
 * operator who wants that note gone has to declare it — and declaring it is a
 * promise that `/search` and `/stream` check the proof the app attaches. The two
 * are one feature, which is why `src/lib/auth.js` gates the routes by the same
 * switch that decides this field.
 *
 * `log` mode declares the flag and does not refuse anyone: the rollout step the
 * docs describe, where credentials are verified and failures are only logged.
 */

import { VERSION, AUTH_MODE } from './config.js';
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

/**
 * The `quality` picker.
 *
 * Two things about this list are load-bearing rather than cosmetic.
 *
 * **The values are what arrives as `?quality=`**, and `matchTier` reads them by
 * meaning, not by position: a tier the app itself is asking for (`LOSSLESS`,
 * `HIGH`, `LOW`) is matched case-insensitively first, then by word (`high`,
 * `320`, `normal`, `standard` for HIGH; `low`, `96`, `128`, `min` for LOW), and
 * failing both it takes the first option — which is therefore the recommended
 * one. So `lossless` first, then `high`, then `low`, and every tier the app can
 * ask for lands on one of them.
 *
 * **The labels are drawn by BitChord**, and it draws this picker in its own
 * words when it can recognise the values. These labels are what is shown when it
 * cannot, so they describe the audio rather than the protocol: what the listener
 * gets, not what the addon calls it.
 *
 * Only two or more usable values make a picker at all; a single option is not a
 * choice and would leave the user with a form that does nothing.
 */
const QUALITY_OPTIONS = [
  { label: 'Lossless (FLAC)', value: 'lossless' },
  { label: 'High (up to 320 kbps)', value: 'high' },
  { label: 'Low (data saver)', value: 'low' },
];

/**
 * Downloads are allowed.
 *
 * Every audio source here serves a URL the app can save, and the alternative — `0`
 * — makes a download skip this addon entirely and take the next source, which for
 * a lossless download is the worst outcome available. What is served is what the
 * catalogue served; there is nothing licence-wise that playback has and a
 * download does not.
 */
const ALLOW_DOWNLOADS = 1;

export const MANIFEST = Object.freeze({
  id: 'dev.onyourride.bitchord.flac',
  name: displayName(),
  version: VERSION,
  resources: ['search', 'stream'],
  allowDownloads: ALLOW_DOWNLOADS,
  // `off` is the only mode that leaves the flag out, because it is the only one
  // that does not check. Anything else declares it, `log` included.
  bitchordAuth: !(AUTH_MODE === 'off'),
  settings: [
    {
      key: 'quality',
      type: 'select',
      default: 'lossless',
      options: QUALITY_OPTIONS,
    },
  ],
});
