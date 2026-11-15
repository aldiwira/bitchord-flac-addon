import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlacStreamInfo, flacKbps, STREAMINFO_BYTES } from '../src/lib/flac.js';
import { encodePart, decodePart, makeTrackId, parseTrackId } from '../src/lib/trackid.js';
import { parseTier, TtlCache, settleAll, cleanSegment } from '../src/lib/http.js';

/**
 * Builds a real FLAC STREAMINFO header.
 *
 * Constructing the bytes by hand rather than pasting a hex dump is what keeps
 * this a test of the parser instead of a test of one fixture: a fixture cannot
 * distinguish a parser that reads bit 44 from one that happens to agree with it
 * on a single sample.
 */
function flacHeader({
  sampleRate = 44100,
  channels = 2,
  bitDepth = 16,
  totalSamples = 44100 * 180,
  blockType = 0,
  lastBlock = false,
} = {}) {
  const head = Buffer.alloc(STREAMINFO_BYTES);
  head.write('fLaC', 0, 'ascii');

  head[4] = (lastBlock ? 0x80 : 0) | blockType;
  head.writeUIntBE(34, 5, 3); // STREAMINFO length is always 34

  const body = head.subarray(8);
  body.writeUInt16BE(4096, 0); // min block size
  body.writeUInt16BE(4096, 2); // max block size
  body.writeUIntBE(2284, 4, 3); // min frame size
  body.writeUIntBE(14508, 7, 3); // max frame size

  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    (BigInt(totalSamples) & 0xfffffffffn);
  body.writeBigUInt64BE(packed, 10);

  return head;
}

describe('parseFlacStreamInfo', () => {
  test('reads a CD-quality stereo header', () => {
    const info = parseFlacStreamInfo(
      flacHeader({ sampleRate: 44100, channels: 2, bitDepth: 16 }),
    );
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.channels, 2);
    assert.equal(info.bitDepth, 16);
    assert.ok(Math.abs(info.durationSec - 180) < 0.001);
  });

  test('reads a hi-res header — 24-bit/96 kHz, the case that breaks naive shifts', () => {
    const info = parseFlacStreamInfo(
      flacHeader({ sampleRate: 96000, channels: 2, bitDepth: 24, totalSamples: 96000 * 300 }),
    );
    assert.equal(info.sampleRate, 96000);
    assert.equal(info.bitDepth, 24);
    assert.equal(info.channels, 2);
    assert.ok(Math.abs(info.durationSec - 300) < 0.001);
  });

  test('reads multichannel — 5.1 and 7.1 exercise the 3-bit channel field', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ channels: 6 })).channels, 6);
    assert.equal(parseFlacStreamInfo(flacHeader({ channels: 8 })).channels, 8);
  });

  test('reads a 32-bit header, the top of the field', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ bitDepth: 32 })).bitDepth, 32);
  });

  test('reads 192 kHz, which is where the 20-bit rate field ends', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ sampleRate: 192000 })).sampleRate, 192000);
  });

  test('rejects bytes that are not FLAC', () => {
    assert.equal(parseFlacStreamInfo(Buffer.from('ID3\x04\x00\x00\x00')), null,
      'an MP3 with an ID3 tag must not parse');
    assert.equal(parseFlacStreamInfo(Buffer.from('\x00\x00\x00\x00')), null);
    assert.equal(parseFlacStreamInfo(Buffer.from('fLa')), null, 'too short');
    assert.equal(parseFlacStreamInfo(null), null);
  });

  test('rejects a FLAC whose first block is not STREAMINFO', () => {
    // Legal FLAC, unreadable cheaply. Returning the numbers of the block that is
    // there would be worse than returning nothing.
    assert.equal(parseFlacStreamInfo(flacHeader({ blockType: 4 })), null,
      'VORBIS_COMMENT first');
    assert.equal(parseFlacStreamInfo(flacHeader({ blockType: 6 })), null, 'PICTURE first');
  });

  test('rejects a header with no usable sample rate', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ sampleRate: 0 })), null);
  });
});

describe('flacKbps', () => {
  test('computes a rate from size and duration', () => {
    // 40 MB over 320 s is about 1013 kbps.
    assert.equal(flacKbps(40_572_194, 320.36), 1013);
  });

  test('returns null rather than a wrong number', () => {
    assert.equal(flacKbps(0, 100), null);
    assert.equal(flacKbps(1000, 0), null);
    assert.equal(flacKbps(NaN, 100), null);
  });
});

describe('track ids', () => {
  test('passes an already-safe id through unchanged, so logs stay readable', () => {
    assert.equal(encodePart('154049681742106624'), '154049681742106624');
    assert.equal(makeTrackId('tidal', '154049681742106624'), 'tidal:154049681742106624');
  });

  test('encodes anything that could break a path segment', () => {
    // A `/` here becomes `%2F` on the wire and is decoded back to a delimiter by
    // the receiving server, which is the whole reason for encoding.
    const nasty = '1959-03-05 The Veldt (dramatized)/Part 2.flac';
    const encoded = encodePart(nasty);
    assert.ok(!encoded.includes('/'), 'must not contain a delimiter');
    assert.ok(!/[?#\s]/.test(encoded), 'must not contain query or space characters');
    assert.equal(decodePart(encoded), nasty);
  });

  test('round-trips a wide spread of awkward filenames', () => {
    for (const value of [
      'simple.flac',
      'with space.flac',
      'with/slash.flac',
      'with?question.flac',
      'with#hash.flac',
      '日本語のタイトル.flac',
      'emoji 🎵.flac',
      'a'.repeat(300) + '.flac',
    ]) {
      assert.equal(decodePart(encodePart(value)), value);
    }
  });

  test('never produces a segment BitChord would split', () => {
    for (const value of ['a/b', 'a?b', 'a#b', 'a b']) {
      assert.equal(makeTrackId('archive', value).includes('?'), false);
      assert.ok(!/[?#\s]/.test(makeTrackId('archive', value)));
    }
  });

  test('parses a round-tripped id back to source and handle', () => {
    const parsed = parseTrackId(makeTrackId('tidal', '154049681742106624'));
    assert.deepEqual(parsed, { source: 'tidal', nativeId: '154049681742106624' });
  });

  test('rejects ids this addon never issued', () => {
    assert.equal(parseTrackId(''), null);
    assert.equal(parseTrackId('no-separator'), null);
    assert.equal(parseTrackId(':leading-colon'), null);
    assert.equal(parseTrackId('tidal:'), null);
  });
});

describe('parseTier', () => {
  test('reads BitChord native tiers', () => {
    assert.equal(parseTier('LOSSLESS'), 'LOSSLESS');
    assert.equal(parseTier('HIGH'), 'HIGH');
    assert.equal(parseTier('LOW'), 'LOW');
  });

  test('reads the spellings its own manifest can declare', () => {
    assert.equal(parseTier('lossless'), 'LOSSLESS');
    assert.equal(parseTier('flac'), 'LOSSLESS');
    assert.equal(parseTier('hires'), 'LOSSLESS');
    assert.equal(parseTier('hi-res'), 'LOSSLESS');
    assert.equal(parseTier('320'), 'HIGH');
    assert.equal(parseTier('128'), 'LOW');
  });

  test('defaults to lossless, the only tier an addon here can serve', () => {
    assert.equal(parseTier(''), 'LOSSLESS');
    assert.equal(parseTier(null), 'LOSSLESS');
    assert.equal(parseTier('something-else'), 'LOSSLESS');
  });
});

describe('TtlCache', () => {
  test('expires an entry', () => {
    const cache = new TtlCache();
    cache.set('k', 'v', 5);
    assert.equal(cache.get('k'), 'v');
    return new Promise((r) => setTimeout(r, 15)).then(() => {
      assert.equal(cache.get('k'), undefined);
    });
  });

  test('does not cache a null result, so a transient failure is retried', () => {
    // The bug this guards: a probe that timed out once must not strip a track
    // of its bit depth for the life of the process.
    const cache = new TtlCache();
    let calls = 0;
    const produce = async () => {
      calls++;
      return calls < 3 ? null : 'recovered';
    };
    return Promise.resolve()
      .then(() => cache.wrap('k', 60_000, produce))
      .then((first) => {
        assert.equal(first, null);
        return cache.wrap('k', 60_000, produce);
      })
      .then((second) => {
        assert.equal(second, null, 'still failing, still not cached');
        return cache.wrap('k', 60_000, produce);
      })
      .then((third) => {
        assert.equal(third, 'recovered', 'a success is now cached');
        return cache.wrap('k', 60_000, produce);
      })
      .then((fourth) => {
        assert.equal(fourth, 'recovered', 'a success is served from cache');
        assert.equal(calls, 3, 'the fourth ask did not reach the producer');
      });
  });

  test('stays bounded', () => {
    const cache = new TtlCache(20);
    for (let i = 0; i < 200; i++) cache.set(`k${i}`, i, 60_000);
    assert.ok(cache.size <= 20, `size was ${cache.size}`);
  });
});

describe('settleAll', () => {
  test('never rejects, so one dead source cannot fail a search', async () => {
    const results = await settleAll([
      async () => 'a',
      async () => {
        throw new Error('source is down');
      },
      async () => 'c',
    ]);
    assert.equal(results.length, 3);
    assert.equal(results[0].value, 'a');
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.message, 'source is down');
    assert.equal(results[2].value, 'c');
  });

  test('preserves input order regardless of completion order', async () => {
    const results = await settleAll([
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return 'slow';
      },
      async () => 'fast',
    ]);
    assert.equal(results[0].value, 'slow');
    assert.equal(results[1].value, 'fast');
  });
});

describe('cleanSegment', () => {
  test('strips control characters that would corrupt a URL', () => {
    assert.equal(cleanSegment('a bc'), 'abc');
    assert.equal(cleanSegment('  spaced  '), 'spaced');
  });
});

import {
  songIdFromUrl,
  codecFromUrl,
  albumFromDetail,
  mapNeteaseRow,
  mapMetingRow,
  withAlbums,
  songsPayload,
} from '../src/lib/sources/netease.js';

describe('NetEase v2 (Meting) helpers', () => {
  test('reads the NetEase id out of a Meting url', () => {
    assert.equal(
      songIdFromUrl('https://api.qijieya.cn/meting/?server=netease&type=url&id=210049'),
      '210049',
    );
    assert.equal(songIdFromUrl('nonsense'), undefined);
    assert.equal(songIdFromUrl('https://x/?type=url'), undefined);
  });

  test('reads the codec from the redirected CDN path', () => {
    assert.equal(codecFromUrl('https://m8.music.126.net/x/y.flac'), 'flac');
    assert.equal(codecFromUrl('https://m8.music.126.net/x/y.mp3'), 'mp3');
    assert.equal(codecFromUrl('https://api.qijieya.cn/meting/?type=url&id=1'), undefined);
  });

  test('mapNeteaseRow builds a complete row — album and duration come with the search', () => {
    const row = mapNeteaseRow({
      id: 2630609057,
      name: 'Wirang',
      artists: [{ name: 'Denny Caknan' }],
      album: { name: 'Wirang', picId: '109951169991174125', picUrl: null },
      duration: 318206,
    });
    assert.equal(row.id, 'netease:2630609057');
    assert.equal(row.title, 'Wirang');
    assert.equal(row.artist, 'Denny Caknan');
    assert.equal(row.album, 'Wirang');
    assert.equal(row.duration, 318.2);
    assert.ok(row.artworkURL.includes('type=pic&id=109951169991174125'),
      'a null picUrl must fall back to the picId Meting dereferences');
    assert.equal(row._nativeId, '2630609057');
  });

  test('mapNeteaseRow prefers a real picUrl and drops unusable entries', () => {
    const row = mapNeteaseRow({
      id: 1,
      name: 'x',
      album: { name: 'A', picUrl: 'http://p1.music.126.net/a.jpg' },
    });
    assert.equal(row.artworkURL, 'https://p1.music.126.net/a.jpg');
    assert.equal(row.duration, undefined, 'NetEase often sends no duration');
    // A falsy id is how NetEase marks a match it cannot serve.
    assert.equal(mapNeteaseRow({ id: 0, name: 'x' }), null);
    assert.equal(mapNeteaseRow({ id: 1, name: '  ' }), null);
  });

  test('mapMetingRow produces a lossless row from Meting metadata', () => {
    const row = mapMetingRow({
      name: '布拉格广场',
      artist: '蔡依林/周杰伦',
      url: 'https://api.qijieya.cn/meting/?server=netease&type=url&id=210049',
      pic: 'http://p1.music.126.net/a.jpg',
    });
    assert.equal(row.id, 'netease:210049');
    assert.equal(row.title, '布拉格广场');
    assert.equal(row.artist, '蔡依林, 周杰伦');
    assert.equal(row.album, '');
    assert.equal(row.artworkURL, 'https://p1.music.126.net/a.jpg');
    assert.equal(row.format, 'flac');
    assert.equal(row.audioQuality, 'LOSSLESS');
    assert.equal(row._source, 'netease');
    assert.equal(row._nativeId, '210049');
  });

  test('mapMetingRow drops a row with no id or title', () => {
    assert.equal(mapMetingRow({ name: 'x' }), null);
    assert.equal(mapMetingRow({ url: 'https://x/?type=url' }), null);
  });

  test('withAlbums keeps every row when the album lookup failed', () => {
    // The bug this guards: a failed album call must cost the album, never the
    // row. An empty map has to be a no-op rather than a filter.
    const rows = [
      { _nativeId: '1', album: '', artworkURL: 'https://p1.music.126.net/pic.jpg' },
      { _nativeId: '2', album: '', artworkURL: undefined },
    ];
    assert.deepEqual(withAlbums(rows, new Map()), rows);
    assert.deepEqual(withAlbums(rows, new Map([['2', { album: 'Wirang' }]])), [
      rows[0],
      { _nativeId: '2', album: 'Wirang', artworkURL: undefined },
    ]);
    // An album with no artwork must not erase the artwork the row already had.
    assert.deepEqual(
      withAlbums([rows[0]], new Map([['1', { album: 'Wirang' }]])),
      [{ _nativeId: '1', album: 'Wirang', artworkURL: 'https://p1.music.126.net/pic.jpg' }],
    );
  });

  test('songsPayload numbers ids and de-duplicates them', () => {
    assert.deepEqual(songsPayload(['1', '2', '1']), [1, 2]);
    assert.deepEqual(songsPayload([]), []);
  });

  test('reads the album out of either detail shape, because NetEase has two', () => {
    // `/api/song/detail` nests `album`; the v3 endpoint nests `al`. Both are
    // live on the public host depending on the request, so both must parse.
    assert.deepEqual(
      albumFromDetail({ album: { name: '看我72变', picUrl: 'http://p1.music.126.net/a.jpg' } }),
      { album: '看我72变', artworkURL: 'https://p1.music.126.net/a.jpg' },
    );
    assert.deepEqual(
      albumFromDetail({ al: { name: 'Promise', picUrl: 'http://p1.music.126.net/b.jpg' } }),
      { album: 'Promise', artworkURL: 'https://p1.music.126.net/b.jpg' },
    );
    assert.deepEqual(albumFromDetail({ id: 1 }), { album: '', artworkURL: undefined });
    assert.deepEqual(albumFromDetail(null), { album: '', artworkURL: undefined });
  });
});

import { httpJson } from '../src/lib/http.js';
import { createServer } from 'node:http';

describe('httpJson preserveIntegers', () => {
  /** A one-shot server, because the behaviour under test is in the parse. */
  const serve = (body) =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${server.address().port}/`, server }),
      );
    });

  test('keeps an id past MAX_SAFE_INTEGER exact instead of rounding it', async () => {
    // The bug: NetEase sends picId 109951169991174125, plain JSON.parse turns it
    // into 109951169991174130, and that id resolves to a different album's cover.
    const body = '{"album":{"picId":109951169991174125,"name":"x"},"duration":318206}';
    const { url, server } = await serve(body);
    try {
      const exact = await httpJson(url, { preserveIntegers: true });
      assert.equal(exact.album.picId, '109951169991174125');

      const lossy = await httpJson(url);
      assert.equal(lossy.album.picId, 109951169991174130, 'the rounding this guards');
      assert.equal(lossy.duration, 318206, 'ordinary numbers stay numbers');
      assert.equal(exact.duration, 318206);
      assert.equal(exact.album.name, 'x', 'strings are untouched');
    } finally {
      server.close();
    }
  });

  test('quotes only integers, never digits inside a string', async () => {
    const { url, server } = await serve('{"url":"https://x/?id=12345678901234567","n":1}');
    try {
      const parsed = await httpJson(url, { preserveIntegers: true });
      assert.equal(parsed.url, 'https://x/?id=12345678901234567');
      assert.equal(parsed.n, 1);
    } finally {
      server.close();
    }
  });
});

import { carryRowId, parseCarryId, pickMatch, norm, artistsOverlap } from '../src/lib/failover.js';

describe('carried track ids', () => {
  const row = {
    id: 'tidal:154049681742106624',
    title: 'One More Time',
    artist: 'Daft Punk',
    duration: 320,
  };

  test('round-trips the metadata a failover needs', () => {
    const carried = parseCarryId(carryRowId(row));
    assert.deepEqual(carried, {
      source: 'tidal',
      rowId: 'tidal:154049681742106624',
      title: 'One More Time',
      artist: 'Daft Punk',
      duration: 320,
    });
  });

  test('is safe as a single path segment', () => {
    // BitChord puts this into `/stream/{id}` as one segment; anything that would
    // be decoded back into a delimiter must not survive as itself.
    const id = carryRowId({ ...row, title: 'A/B ? C# D', artist: 'Ünicode & Co' });
    assert.ok(!/[?#\s]/.test(id), id);
    assert.ok(!id.slice(id.indexOf(':') + 1).includes('/'), id);
    assert.equal(parseCarryId(id).title, 'A/B ? C# D');
  });

  test('carries the archive id whole, because it is two parts', () => {
    const archiveRow = {
      id: 'archive:some-identifier:ZmlsZW5hbWUuZmxhYw',
      title: 'So What',
      artist: 'Miles Davis',
      duration: 547,
    };
    const carried = parseCarryId(carryRowId(archiveRow));
    assert.equal(carried.rowId, archiveRow.id, 'the identifier must survive');
    assert.equal(carried.source, 'archive');
  });

  test('refuses ids this addon did not issue', () => {
    for (const id of [
      'tidal:154049681742106624',
      '',
      'no-separator',
      'tidal:not-json',
      `tidal:${Buffer.from('{"v":99,"r":"tidal:1","t":"x"}').toString('base64url')}`,
      `tidal:${Buffer.from('{"v":1,"r":"tidal:1","t":"  "}').toString('base64url')}`,
    ]) {
      assert.equal(parseCarryId(id), null, `should refuse ${id}`);
    }
  });

  test('hands back an id it cannot wrap rather than inventing one', () => {
    assert.equal(carryRowId({ id: 'nonsense', title: 'x' }), 'nonsense');
  });
});

describe('pickMatch', () => {
  const meta = { title: 'One More Time', artist: 'Daft Punk', duration: 320 };

  test('accepts the same recording and rejects a different one', () => {
    const rows = [
      { id: 'a', title: 'One More Time', artist: 'Daft Punk', duration: 321 },
      { id: 'b', title: 'One More Time (Live)', artist: 'Daft Punk', duration: 320 },
      { id: 'c', title: 'One More Time', artist: 'Someone Else', duration: 320 },
      { id: 'd', title: 'One More Time', artist: 'Daft Punk', duration: 900 },
    ];
    assert.equal(pickMatch(rows, meta).id, 'a');
  });

  test('refuses a match when only one side states a duration it disagrees with', () => {
    // A live version is 9 minutes. The duration is what catches it; the title
    // alone would not.
    assert.equal(
      pickMatch([{ id: 'a', title: 'One More Time', artist: 'Daft Punk', duration: 540 }], meta),
      null,
    );
  });

  test('accepts a match when neither side states a duration', () => {
    assert.equal(
      pickMatch([{ id: 'a', title: 'One More Time', artist: 'Daft Punk' }], meta).id,
      'a',
    );
  });

  test('returns null for no rows and for an unusable title', () => {
    assert.equal(pickMatch([], meta), null);
    assert.equal(pickMatch(null, meta), null);
    assert.equal(pickMatch([{ id: 'a', title: 'x', artist: 'Daft Punk' }], { ...meta, title: '' }), null);
  });

  test('folds an accent rather than requiring the same spelling', () => {
    const row = { id: 'a', title: 'Jóga', artist: 'Björk', duration: 300 };
    assert.equal(pickMatch([row], { title: 'Joga', artist: 'Bjork', duration: 300 }).id, 'a');
  });
});

describe('artist strings', () => {
  test('overlap in either order, which is how catalogues disagree', () => {
    assert.ok(artistsOverlap('Timbaland, Justin Timberlake', 'Justin Timberlake, Timbaland'));
    assert.ok(artistsOverlap('Justin Timberlake feat. Timbaland', 'Justin Timberlake'));
  });

  test('accept a reversed "Last, First" credit', () => {
    assert.ok(artistsOverlap('Davis, Miles', 'Miles Davis'));
  });

  test('do not overlap when the artists differ', () => {
    assert.equal(artistsOverlap('Daft Punk', 'Miles Davis'), false);
    assert.equal(artistsOverlap('', 'Daft Punk'), false);
  });

  test('norm drops release qualifiers and featured credits', () => {
    assert.equal(norm('One More Time (Remastered 2021)'), 'one more time');
    assert.equal(norm('Song [Deluxe Edition]'), 'song');
    assert.equal(norm('Song feat. Someone'), 'song');
  });
});

import { failover, clearMatchCache } from '../src/lib/failover.js';
import { NotFound, UpstreamError } from '../src/lib/http.js';
import { ACTIVE } from '../src/registry.js';

describe('failover', () => {
  // The match cache is process-wide. Each scenario below asserts a different
  // outcome for the same recording, so it must not serve one scenario's answer
  // to the next.
  beforeEach(() => clearMatchCache());

  // A fixed three-catalogue world, injected rather than read from `ACTIVE`, so
  // the walk is exercised in full whatever `SOURCES` the process was started
  // with. Names match real registry ids so the assertions read like the log.
  const tidal = { id: 'tidal' };
  const netease = { id: 'netease' };
  const archive = { id: 'archive' };
  const sources = [tidal, netease, archive];

  const carried = {
    source: 'tidal',
    rowId: 'tidal:154049681742106624',
    title: 'One More Time',
    artist: 'Daft Punk',
    duration: 320,
  };

  test('never leaves the issuing source when it can serve its own row', async () => {
    const asked = [];
    const searched = [];
    const result = await failover(carried, 'LOSSLESS', undefined, {
      sources,
      searchAt: async (source) => {
        searched.push(source.id);
        return [];
      },
      resolveAt: async (source, rowId) => {
        asked.push(source.id);
        if (source.id !== 'tidal') throw new Error('should not have been asked');
        assert.equal(rowId, 'tidal:154049681742106624', 'the real row id, not the container');
        return { url: 'https://example/one.flac' };
      },
    });

    assert.equal(result.source, 'tidal');
    assert.equal(result.issuer, 'tidal');
    assert.deepEqual(asked, ['tidal']);
    assert.deepEqual(searched, [], 'no catalogue was searched when nothing failed');
  });

  test('walks to another source when its own misses, and reports which one served it', async () => {
    const asked = [];
    const result = await failover(carried, 'LOSSLESS', undefined, {
      sources,
      searchAt: async (source, query) => {
        assert.equal(query, 'Daft Punk One More Time', 'the query is rebuilt from the id');
        // Every candidate catalogue has the recording.
        return [{ id: `${source.id}:999`, title: 'One More Time', artist: 'Daft Punk', duration: 321 }];
      },
      resolveAt: async (source, rowId) => {
        asked.push(source.id);
        if (source.id === 'tidal') throw new NotFound('index has metadata but no file');
        assert.match(rowId, new RegExp(`^${source.id}:`), 'a candidate resolves its own row id');
        return { url: `https://example/${source.id}.flac` };
      },
    });

    assert.equal(result.source, 'netease', 'the first candidate in registry order won');
    assert.equal(result.issuer, 'tidal', 'the issuing source is still reported');
    assert.equal(result.rowId, 'netease:999');
    assert.equal(result.result.url, 'https://example/netease.flac');
    assert.deepEqual(asked, ['tidal', 'netease'], 'resolution stopped at the first success');
  });

  test('walks past a candidate that is broken, not only one that misses', async () => {
    const result = await failover(carried, 'LOSSLESS', undefined, {
      sources,
      searchAt: async (source) => [
        { id: `${source.id}:1`, title: 'One More Time', artist: 'Daft Punk', duration: 320 },
      ],
      resolveAt: async (source) => {
        if (source.id === 'tidal') throw new NotFound('no file');
        if (source.id === 'netease') throw new UpstreamError('connection reset');
        return { url: 'https://example/archive.flac' };
      },
    });

    assert.equal(result.source, 'archive', 'a broken candidate did not end the walk');
  });

  test('reports a miss when nothing in the addon holds the recording', async () => {
    await assert.rejects(
      () => failover(carried, 'LOSSLESS', undefined, {
        sources,
        searchAt: async () => [],
        resolveAt: async () => {
          throw new NotFound('no rendition');
        },
      }),
      (error) => error instanceof NotFound,
    );
  });

  test('never resolves a row no candidate matched, however desperate it is', async () => {
    // The failure this guards: resolving the *first* open id rather than the one
    // that is the same recording, which plays the wrong track instead of none.
    const asked = [];
    await assert.rejects(
      () => failover(carried, 'LOSSLESS', undefined, {
        sources,
        searchAt: async () => [
          { id: 'netease:1', title: 'One More Time (Live)', artist: 'Daft Punk', duration: 320 },
          { id: 'netease:2', title: 'Around the World', artist: 'Daft Punk', duration: 320 },
        ],
        resolveAt: async (source, rowId) => {
          asked.push(rowId);
          throw new NotFound('no rendition');
        },
      }),
      (error) => error instanceof NotFound,
    );
    assert.deepEqual(asked, ['tidal:154049681742106624'], 'only the own-source attempt');
  });

  test('skips the issuing source entirely when this process does not run it', async () => {
    // A stale row from a deployment configured with a different `SOURCES`.
    const asked = [];
    const result = await failover({ ...carried, known: false }, 'LOSSLESS', undefined, {
      sources,
      searchAt: async (source) => [
        { id: `${source.id}:1`, title: 'One More Time', artist: 'Daft Punk', duration: 320 },
      ],
      resolveAt: async (source) => {
        asked.push(source.id);
        return { url: 'https://example/x.flac' };
      },
    });

    assert.ok(!asked.includes('tidal'), 'a source that is not configured must not be asked');
    assert.equal(result.source, 'netease');
  });
});

import { carryRowId as carry } from '../src/lib/failover.js';
import { probeFlac, describeMedia, lossyAnswer } from '../src/lib/probe.js';
import { ALIASES, REGISTRY } from '../src/registry.js';

describe('catalogue-only sources', () => {
  test('Deezer is registered without a resolve, which is what sends it to failover', () => {
    const deezer = REGISTRY.get('deezer');
    assert.ok(deezer, 'must be registered so its rows are recognised');
    assert.equal(typeof deezer.resolve, 'undefined');
    assert.equal(deezer.catalogueOnly, true);
  });

  test('resolving a deezer row is a miss, not a crash', async () => {
    const { resolveAt } = await import('../src/lib/resolve.js');
    await assert.rejects(
      () => resolveAt(REGISTRY.get('deezer'), 'deezer:3135556', 'LOSSLESS'),
      (error) => error instanceof NotFound,
    );
  });
});

describe('legacy id prefixes', () => {
  test('an id minted under the old prefix is understood and re-minted canonically', () => {
    // `qb:` was Qobuz, `mc:` Monochrome, `dz:` Deezer in an earlier deployment.
    // The row is still in somebody's queue, so it must still resolve.
    const carried = parseCarryId(
      carry({ id: 'qb:13176085', title: 'So What', artist: 'Miles Davis', duration: 547 }),
    );
    assert.equal(carried.source, 'qobuz', 'the alias resolved to the canonical id');
    assert.equal(carried.rowId, 'qobuz:13176085', 'and the id was re-minted canonically');
  });

  test('canonical ids are left exactly as they were', () => {
    for (const [alias, canonical] of ALIASES) {
      const row = { id: `${canonical}:42`, title: 'x', artist: 'y', duration: 1 };
      const carried = parseCarryId(carry(row));
      assert.equal(carried.rowId, `${canonical}:42`);
      assert.notEqual(carried.source, alias);
    }
  });

  test('a NeteaseCloudMusicApi row still resolves after that source was replaced', () => {
    // The NeteaseCloudMusicApi source was replaced by the Meting one, which now
    // lives in `netease.js` under the same `netease:` prefix — both name the
    // same NetEase song id, so a row issued before the swap still arrives.
    assert.ok(REGISTRY.has('netease'), 'the replacement must be registered');
    const carried = parseCarryId(
      carry({ id: 'netease:5257138', title: '屋顶', artist: '周杰伦', duration: 393 }),
    );
    assert.equal(carried.source, 'netease');
    assert.equal(carried.rowId, 'netease:5257138');
  });

  test('no alias shadows a registered source id', () => {
    // `/health` lists every registry key; an alias that is also a key would make
    // one source appear twice and hide which one a prefix means.
    for (const alias of ALIASES.keys()) assert.equal(REGISTRY.has(alias), false, alias);
  });
});

describe('lossy answers', () => {
  test('a non-FLAC answer is labelled, not refused', () => {
    const answer = lossyAnswer('https://example/x.mp3', 'mp3');
    assert.equal(answer.codec, 'mp3');
    assert.equal(answer.encrypted, false);
    assert.equal(answer.sampleRate, null, 'no claim about audio it did not read');
    assert.equal(answer.probed, false);
  });
});

describe('a throttle is not a miss', () => {
  test('failover surfaces an unavailable candidate instead of claiming a miss', async () => {
    // The bug this guards: a 429 from the one catalogue that has the recording
    // was reported as 404, so BitChord moved on to another source and the track
    // was lost — although asking again a minute later would have worked.
    const tidal = { id: 'tidal' };
    const netease = { id: 'netease' };
    const carried = {
      source: 'tidal',
      rowId: 'tidal:1',
      title: 'One More Time',
      artist: 'Daft Punk',
      duration: 320,
    };

    await assert.rejects(
      () => failover(carried, 'LOSSLESS', undefined, {
        sources: [tidal, netease],
        searchAt: async () => [
          { id: 'netease:1', title: 'One More Time', artist: 'Daft Punk', duration: 320 },
        ],
        resolveAt: async (source) => {
          if (source.id === 'tidal') throw new NotFound('no file');
          throw new UpstreamError('rate limited', { status: 429 });
        },
      }),
      // NotFound would be a 404 to BitChord, which is the wrong claim.
      (error) => !(error instanceof NotFound) && error.status === 429,
    );
  });

  test('a throttled search does not poison the match cache', async () => {
    const tidal = { id: 'tidal' };
    const netease = { id: 'netease' };
    const carried = {
      source: 'tidal',
      rowId: 'tidal:1',
      title: 'One More Time',
      artist: 'Daft Punk',
      duration: 320,
    };

    clearMatchCache();

    // First ask: the only candidate that has it is throttled.
    await assert.rejects(
      () => failover(carried, 'LOSSLESS', undefined, {
        sources: [tidal, netease],
        searchAt: async () => {
          throw new UpstreamError('rate limited', { status: 429 });
        },
        resolveAt: async () => {
          throw new NotFound('no file');
        },
      }),
      (error) => error instanceof NotFound,
    );

    // Second ask: the throttle is gone and the recording is found. If the first
    // attempt had cached its empty match set, this would return the stale empty.
    const result = await failover(carried, 'LOSSLESS', undefined, {
      sources: [tidal, netease],
      searchAt: async (source) =>
        source.id === 'netease'
          ? [{ id: 'netease:1', title: 'One More Time', artist: 'Daft Punk', duration: 320 }]
          : [],
      // Tidal's own row still misses; only netease can serve it.
      resolveAt: async (source) => {
        if (source.id === 'tidal') throw new NotFound('no file');
        return { url: 'https://example/ok.flac' };
      },
    });

    assert.equal(result.source, 'netease', 'the throttle must not have been cached');
  });
});


import { MANIFEST } from '../src/manifest.js';

describe('the manifest', () => {
  test('declares only fields AddonManifest has a reader for', () => {
    // ignoreUnknownKeys is on, so anything else is silently discarded — the
    // failure mode is a claim made to nobody, not a parse error.
    const known = ['id', 'name', 'version', 'resources', 'allowDownloads',
      'checkValidLossless', 'settings'];
    for (const key of Object.keys(MANIFEST)) {
      assert.ok(known.includes(key), `"${key}" has no reader in AddonManifest`);
    }
  });

  test('does not gate itself on a lossless output', () => {
    // Absent means no output check. Declaring it hides the addon on a Bluetooth
    // headset, which is the listener's decision to make, not the manifest's.
    assert.equal(MANIFEST.checkValidLossless, undefined);
  });

  test('states that downloads are allowed', () => {
    assert.equal(MANIFEST.allowDownloads, 1);
  });

  test('the quality picker has a distinct option for every tier', () => {
    const options = MANIFEST.settings.find((s) => s.key === 'quality').options;
    const values = options.map((o) => o.value);
    assert.deepEqual(values, ['lossless', 'high', 'low']);
    // matchTier falls back to the first option, so a missing tier is served as
    // lossless. The check that matters is that parseTier agrees with each.
    for (const value of values) {
      assert.equal(parseTier(value), value.toUpperCase());
    }
  });

  test('the declared default is one of the options', () => {
    const setting = MANIFEST.settings.find((s) => s.key === 'quality');
    assert.ok(setting.options.some((o) => o.value === setting.default));
  });
});
