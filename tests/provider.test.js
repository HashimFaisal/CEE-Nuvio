'use strict';

const assert = require('assert');
const { getStreams } = require('../index');

const response = (data, ok, status) => ({
  ok: ok !== false,
  status: status || 200,
  text: async () => JSON.stringify(data)
});

async function main() {
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
      return response([{ nb: 203, season: 2, episodeNummer: 3 }]);
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
        { videoUrl: 'https://cdn.example/movie-1080.mp4', resolution: '1080p', container: 'mp4' },
        { videoUrl: 'https://cdn.example/movie-1080.mp4', resolution: '1080p', container: 'mp4' }
      ]);
    }
    if (value.includes('/transcoddedFiles/id/203')) {
      return response([{ videoUrl: 'https://cdn.example/episode.mp4', resolution: '1080p', container: 'mp4' }]);
    }
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
    assert.deepStrictEqual(movie.map((item) => item.name), ['CEE · 1080p', 'CEE · 720p']);
    assert.strictEqual(movie.length, 2, 'duplicate stream URLs must be removed');
    assert.deepStrictEqual(Object.keys(movie[0]).sort(), ['name', 'title', 'url'],
      'CEE stream objects must match the Cinemana name/title/url schema');

    const tmdbMovie = await getStreams({ tmdbId: 603, mediaType: 'movie' });
    assert.strictEqual(tmdbMovie.length, 2, 'numeric TMDB IDs must resolve with the injected key');

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
