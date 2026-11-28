'use strict';

const assert = require('assert');
const { getStreams } = require('../index');

const response = (data, ok, status) => ({
  ok: ok !== false,
  status: status || 200,
  text: async () => JSON.stringify(data)
});

async function main() {
  let detailsRequests = 0;
  const originalFetch = global.fetch;
  global.TMDB_API_KEY = 'test-key';

  global.fetch = async function (url) {
    const value = String(url);

    if (value.includes('/meta/movie/tt0133093')) {
      return response({ meta: { name: 'The Matrix', year: '1999' } });
    }
    if (value.includes('api.themoviedb.org/3/movie/603')) {
      return response({
        id: 603,
        title: 'The Matrix',
        original_title: 'The Matrix',
        release_date: '1999-03-31',
        imdb_id: 'tt0133093',
        translations: { translations: [] }
      });
    }
    if (value.includes('/meta/series/tt1111111')) {
      return response({ meta: { name: 'Test Show', year: '2020' } });
    }
    if (value.includes('/meta/series/tt2222222')) {
      return response({ meta: { name: 'Ambiguous Show', year: '2021' } });
    }

    if (value.includes('/AdvancedSearch')) {
      if (value.includes('The%20Matrix')) {
        return response([{ nb: 10, kind: 1, en_title: 'The Matrix', year: '1999', imdbUrlRef: 'tt0133093' }]);
      }
      if (value.includes('Test%20Show')) {
        return response([{ nb: 20, kind: 2, en_title: 'Test Show', year: '2020', imdbUrlRef: 'tt1111111' }]);
      }
      if (value.includes('Ambiguous%20Show')) {
        return response([{ nb: 30, kind: 2, en_title: 'Ambiguous Show', year: '2021', imdbUrlRef: 'tt2222222' }]);
      }
      return response([]);
    }

    if (value.includes('/videoSeason/id/20')) {
      return response([{ nb: 203, description: 'S02E03' }]);
    }
    if (value.includes('/videoSeason/id/30')) {
      return response([
        { nb: 301, season: 1, episodeNummer: 2 },
        { nb: 302, season: 1, episodeNummer: 2 }
      ]);
    }
    if (value.includes('/transcoddedFiles/id/10')) return response([]);
    if (value.includes('/transcodedFiles/id/10')) {
      return response([
        { videoUrl: 'https://cdn.example/movie-720.mp4', resolution: '720p', container: 'mp4' },
        { videoUrl: 'https://cdn.example/movie-4k.mp4', resolution: '2160p', container: 'mp4' },
        { videoUrl: 'https://cdn.example/movie-1080.mp4', resolution: '1080p', container: 'mp4' },
        { videoUrl: 'https://cdn.example/movie-1080.mp4', resolution: '1080p', container: 'mp4' }
      ]);
    }
    if (value.includes('/transcoddedFiles/id/203')) {
      return response([{ videoUrl: 'https://cdn.example/episode.mp4', resolution: '1080p', container: 'mp4' }]);
    }
    if (value.includes('/allVideoInfo/')) detailsRequests++;
    if (value.includes('/allVideoInfo/id/10')) {
      return response({
        ar_title: 'الماتريكس',
        en_title: 'The Matrix',
        translations: [{ id: 1, file: 'https://subs.example/ar.srt', extention: 'srt', type: 'ar' }]
      });
    }
    if (value.includes('/allVideoInfo/id/203')) {
      return response({ ar_title: 'مسلسل تجريبي', en_title: 'Test Show', translations: [] });
    }

    return response({ error: 'not found' }, false, 404);
  };

  try {
    const movie = await getStreams({ tmdbId: 'tt0133093', mediaType: 'movie' });
    assert.deepStrictEqual(movie.map((item) => item.name), ['CEE · 4K', 'CEE · 1080p', 'CEE · 720p']);
    assert.strictEqual(movie.length, 3, 'duplicate stream URLs must be removed while retaining available 4K sources');
    assert.strictEqual(detailsRequests, 0, 'playback resolution must not wait for unused allVideoInfo metadata');
    assert.deepStrictEqual(Object.keys(movie[0]).sort(), ['behaviorHints', 'name', 'quality', 'title', 'url'],
      'CEE stream objects should expose CinemaBox-compatible quality metadata and playback headers');
    assert.deepStrictEqual(movie[0].behaviorHints.proxyHeaders, {
      request: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
        Referer: 'https://nuvio.tv/'
      }
    }, 'default playback request headers must be supplied when the API omits them');

    const originalFetchForHeaders = global.fetch;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt3333333')) {
        return response({ meta: { name: 'Header Test', year: '2022' } });
      }
      if (value.includes('/AdvancedSearch')) {
        return response([{ nb: 40, kind: 1, en_title: 'Header Test', year: '2022', imdbUrlRef: 'tt3333333' }]);
      }
      if (value.includes('/transcoddedFiles/id/40')) {
        return response([{
          videoUrl: 'https://cdn.example/header-test.mp4',
          resolution: '1080p',
          requestHeaders: { Referer: 'https://cee.buzz/', Authorization: 'Bearer test' },
          responseHeaders: { 'Content-Type': 'video/mp4' }
        }]);
      }
      if (value.includes('/allVideoInfo/id/40')) return response({ en_title: 'Header Test' });
      return response({ error: 'not found' }, false, 404);
    };
    const headerStreams = await getStreams({ tmdbId: 'tt3333333', mediaType: 'movie' });
    assert.deepStrictEqual(headerStreams[0].behaviorHints.proxyHeaders, {
      request: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
        Referer: 'https://cee.buzz/',
        Authorization: 'Bearer test'
      },
      response: { 'Content-Type': 'video/mp4' }
    }, 'explicit playback headers must override defaults and be forwarded to Nuvio');
    global.fetch = originalFetchForHeaders;

    assert.strictEqual(detailsRequests, 0, 'optional details endpoint must remain outside the playback path');

    const tmdbMovie = await getStreams({ tmdbId: 603, mediaType: 'movie' });
    assert.strictEqual(tmdbMovie.length, 3, 'numeric TMDB IDs must resolve with the injected key');

    const episode = await getStreams({
      tmdbId: 'tt1111111',
      mediaType: 'tv',
      season: 2,
      episode: 3
    });
    assert.strictEqual(episode.length, 1, 'one exact episode match should return streams');

    const ambiguous = await getStreams({
      tmdbId: 'tt2222222',
      mediaType: 'tv',
      season: 1,
      episode: 2
    });
    assert.strictEqual(ambiguous.length, 0, 'ambiguous episode matches must be rejected');

    const originalFetchForEarlyStop = global.fetch;
    let searchRequests = 0;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt4444444')) {
        return response({ meta: { name: 'Concurrent Test', original_name: 'Concurrent Alias', year: '2023' } });
      }
      if (value.includes('/AdvancedSearch')) {
        searchRequests++;
        return response([{
          nb: 44, kind: 1, en_title: 'Concurrent Test', year: '2023',
          imdbUrlRef: 'tt4444444'
        }]);
      }
      if (value.includes('/transcoddedFiles/id/44')) {
        return response([{ videoUrl: 'https://cdn.example/concurrent.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const earlyStopResult = await getStreams({ tmdbId: 'tt4444444', mediaType: 'movie' });
    assert.strictEqual(earlyStopResult.length, 1, 'primary exact match should return the stream');
    assert.strictEqual(searchRequests, 1,
      'a strong first-page match must stop title-variant requests instead of waiting for aliases');
    global.fetch = originalFetchForEarlyStop;

    const originalFetchForFallback = global.fetch;
    let fallbackSearchRequests = 0;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt4444445')) {
        return response({ meta: { name: 'Fallback Test', original_name: 'Fallback Alias', year: '2025' } });
      }
      if (value.includes('/AdvancedSearch')) {
        fallbackSearchRequests++;
        if (value.includes('Fallback%20Test%202025')) {
          return response([{ nb: 45, kind: 1, en_title: 'Fallback Test', year: '2025', imdbUrlRef: 'tt4444445' }]);
        }
        return response([]);
      }
      if (value.includes('/transcoddedFiles/id/45')) {
        return response([{ videoUrl: 'https://cdn.example/fallback.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const fallbackResult = await getStreams({ tmdbId: 'tt4444445', mediaType: 'movie' });
    assert.strictEqual(fallbackResult.length, 1, 'year-qualified fallback should resolve when the primary title search is empty');
    assert.strictEqual(fallbackSearchRequests, 3,
      'year-qualified and alternate-title fallbacks should run after a weak primary result');
    global.fetch = originalFetchForFallback;

    const originalFetchForParallelFallback = global.fetch;
    let fallbackStarted = 0;
    let firstFallbackFinished = false;
    let fallbacksStartedConcurrently = false;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt4444446')) {
        return response({ meta: { name: 'Parallel Fallback', original_name: 'Parallel Alias', year: '2025' } });
      }
      if (value.includes('/AdvancedSearch')) {
        if (value.includes('Parallel%20Fallback%202025') === false &&
            value.includes('Parallel%20Alias') === false) return response([]);
        fallbackStarted++;
        if (fallbackStarted === 2 && !firstFallbackFinished) fallbacksStartedConcurrently = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (fallbackStarted === 1) firstFallbackFinished = true;
        return response([{
          nb: 46, kind: 1, en_title: 'Parallel Fallback', year: '2025',
          imdbUrlRef: 'tt4444446'
        }]);
      }
      if (value.includes('/transcoddedFiles/id/46')) {
        return response([{ videoUrl: 'https://cdn.example/parallel-fallback.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const parallelFallbackResult = await getStreams({ tmdbId: 'tt4444446', mediaType: 'movie' });
    assert.strictEqual(parallelFallbackResult.length, 1,
      'parallel title fallbacks should still resolve the matching CEE stream');
    assert.strictEqual(fallbackStarted, 2, 'both fallback title variants should be requested');
    assert.strictEqual(fallbacksStartedConcurrently, true,
      'fallback title variants should start concurrently rather than serially');
    global.fetch = originalFetchForParallelFallback;

    const originalFetchForFastFallback = global.fetch;
    let slowAliasFinished = false;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt4444447')) {
        return response({ meta: { name: 'Fast External Fallback', original_name: 'Slow Alias', year: '2025' } });
      }
      if (value.includes('/AdvancedSearch')) {
        if (value.includes('Fast%20External%20Fallback%202025')) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          slowAliasFinished = true;
          return response([]);
        }
        if (value.includes('Slow%20Alias')) {
          return response([{
            nb: 47, kind: 1, en_title: 'Fast External Fallback', year: '2025',
            imdbUrlRef: 'tt4444447'
          }]);
        }
        return response([]);
      }
      if (value.includes('/transcoddedFiles/id/47')) {
        return response([{ videoUrl: 'https://cdn.example/fast-external-fallback.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const fastFallbackStarted = Date.now();
    const fastFallbackStreams = await getStreams({ tmdbId: 'tt4444447', mediaType: 'movie' });
    const fastFallbackElapsed = Date.now() - fastFallbackStarted;
    assert.strictEqual(fastFallbackStreams.length, 1,
      'an exact external-ID fallback should resolve the stream');
    assert.strictEqual(slowAliasFinished, false,
      'an exact external-ID fallback must not wait for a slower alias search');
    assert.ok(fastFallbackElapsed < 220,
      'an exact external-ID fallback should return before the slow alias finishes');
    global.fetch = originalFetchForFastFallback;

    const originalFetchForSuppliedMeta = global.fetch;
    let metadataLookups = 0;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('api.themoviedb.org') || value.includes('/meta/')) {
        metadataLookups++;
        return response({ error: 'metadata lookup should have been skipped' }, false, 500);
      }
      if (value.includes('/AdvancedSearch')) {
        return response([{
          nb: 55, kind: 1, en_title: 'Fast Path Movie', year: '2024',
          imdbUrlRef: 'tt5555555'
        }]);
      }
      if (value.includes('/transcoddedFiles/id/55')) {
        return response([{ videoUrl: 'https://cdn.example/fast-path.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const suppliedMetaStreams = await getStreams({
      tmdbId: 555,
      mediaType: 'movie',
      meta: {
        name: 'Fast Path Movie',
        original_name: 'Fast Path Movie',
        year: '2024',
        imdb_id: 'tt5555555'
      }
    });
    assert.strictEqual(suppliedMetaStreams.length, 1,
      'Nuvio-supplied metadata should resolve CEE streams without an external metadata request');
    assert.strictEqual(metadataLookups, 0,
      'supplied metadata fast path must skip TMDB/Cinemeta lookup');
    global.fetch = originalFetchForSuppliedMeta;

    const originalFetchForRetry = global.fetch;
    let transientAttempts = 0;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt6666666')) {
        return response({ meta: { name: 'Retry Test', year: '2024' } });
      }
      if (value.includes('/AdvancedSearch')) {
        transientAttempts++;
        if (transientAttempts === 1) return response({ error: 'temporary upstream error' }, false, 503);
        return response([{ nb: 66, kind: 1, en_title: 'Retry Test', year: '2024', imdbUrlRef: 'tt6666666' }]);
      }
      if (value.includes('/transcoddedFiles/id/66')) {
        return response([{ videoUrl: 'https://cdn.example/retry.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const retriedStreams = await getStreams({ tmdbId: 'tt6666666', mediaType: 'movie' });
    assert.strictEqual(retriedStreams.length, 1, 'transient 503 responses should be retried once');
    assert.strictEqual(transientAttempts, 2, 'GET retry policy must be bounded to one retry');
    global.fetch = originalFetchForRetry;

    const originalFetchForPageTwo = global.fetch;
    let pageTwoRequested = false;
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/meta/movie/tt7777777')) {
        return response({ meta: { name: 'Page Two Search', original_name: 'Page Two Search', year: '2024' } });
      }
      if (value.includes('/AdvancedSearch')) {
        if (value.includes('page=1')) {
          pageTwoRequested = true;
          return response([{ nb: 77, kind: 1, en_title: 'Page Two Search', year: '2024', imdbUrlRef: 'tt7777777' }]);
        }
        if (value.includes('page=0') && value.includes('Page%20Two%20Search')) {
          return response(Array.from({ length: 12 }, function (_, index) {
            return { nb: 700 + index, kind: 1, en_title: 'Unrelated Result ' + index, year: '2024' };
          }));
        }
        return response([]);
      }
      if (value.includes('/transcoddedFiles/id/77')) {
        return response([{ videoUrl: 'https://cdn.example/page-two.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    const pageTwoStreams = await getStreams({ tmdbId: 'tt7777777', mediaType: 'movie' });
    assert.strictEqual(pageTwoStreams.length, 1,
      'a matching CEE title on page 2 should be found when page 1 is full and inconclusive');
    assert.strictEqual(pageTwoRequested, true, 'second-page search should only be attempted after a full inconclusive first page');
    global.fetch = originalFetchForPageTwo;


    // Nuvio embedded-runtime regression: successful playback requests must not
    // schedule per-request timeout handles. CinemaBox avoids these timers because
    // cleared handles can keep a completed scraper invocation alive.
    const originalFetchForTimerRegression = global.fetch;
    const originalSetTimeout = global.setTimeout;
    let scheduledTimers = 0;
    global.setTimeout = function () {
      scheduledTimers++;
      return originalSetTimeout.apply(this, arguments);
    };
    global.fetch = async function (url) {
      const value = String(url);
      if (value.includes('/AdvancedSearch')) {
        return response([{ nb: 88, kind: 1, en_title: 'Timer-Free Request', year: '2024', imdbUrlRef: 'tt8888888' }]);
      }
      if (value.includes('/transcoddedFiles/id/88')) {
        return response([{ videoUrl: 'https://cdn.example/timer-free.mp4', resolution: '1080p' }]);
      }
      return response({ error: 'not found' }, false, 404);
    };
    try {
      const timerFreeStreams = await getStreams({
        tmdbId: 'tt8888888',
        mediaType: 'movie',
        meta: { name: 'Timer-Free Request', original_name: 'Timer-Free Request', year: '2024', imdb_id: 'tt8888888' }
      });
      assert.strictEqual(timerFreeStreams.length, 1, 'timer-free request path should still return streams');
      assert.strictEqual(scheduledTimers, 0,
        'successful CEE HTTP requests must not schedule per-request timeout timers');
    } finally {
      global.fetch = originalFetchForTimerRegression;
      global.setTimeout = originalSetTimeout;
    }

    console.log('CEE provider tests passed');
  } finally {
    global.fetch = originalFetch;
        delete global.TMDB_API_KEY;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
