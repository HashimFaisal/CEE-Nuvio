'use strict';

/*
 * CEE Nuvio provider — independent implementation.
 * Uses CEE's public web API; no CinemaBox or Cinemana dependency.
 */


// Bundled CEE provider engine. Source: engine/provider-engine.js.
// Nuvio loads a single index.js, so this orchestration layer is bundled here.
function createProviderEngine(options) {
  const config = options || {};
  const providers = (config.providers || []).slice();
  const timeoutMs = Math.max(500, Number(config.providerTimeoutMs) || 45000);
  const failureThreshold = Math.max(1, Number(config.failureThreshold) || 2);
  const cooldownMs = Math.max(1000, Number(config.cooldownMs) || 30000);
  const now = config.now || Date.now;
  const health = new Map();

  function qualityRank(value) {
    const match = String(value || '').match(/(2160|1440|1080|720|576|480|360|240)/);
    return match ? Number(match[1]) : 0;
  }
  function validStreamUrl(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\\s\\\\]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !!parsed.hostname && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  }
  function normalizeStream(stream, provider) {
    if (!stream || !validStreamUrl(stream.url)) return null;
    const quality = String(stream.quality || stream.resolution || 'Video');
    const label = provider.name + ' · ' + quality;
    const output = {
      name: String(stream.name || label),
      title: String(stream.title || quality + ' • ' + provider.name),
      url: stream.url
    };
    if (stream.behaviorHints && typeof stream.behaviorHints === 'object') {
      output.behaviorHints = stream.behaviorHints;
    }
    return output;
  }

  providers.forEach(provider => {
    if (!provider || !provider.id || typeof provider.getStreams !== 'function') {
      throw new TypeError('Invalid provider adapter');
    }
    health.set(provider.id, {
      attempts: 0, successes: 0, empty: 0, errors: 0, timeouts: 0,
      failures: 0, openUntil: 0, latencyEwmaMs: null, lastStatus: 'never'
    });
  });

  async function runProvider(provider, context) {
    const state = health.get(provider.id);
    if (state.openUntil > now()) return { providerId: provider.id, status: 'circuit-open', streams: [] };
    const started = now();
    state.attempts++;
    let timer;
    let timedOut = false;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const providerContext = Object.assign({}, context, {
        providerId: provider.id, signal: controller ? controller.signal : undefined,
        deadline: started + timeoutMs
      });
      const work = Promise.resolve().then(() => provider.getStreams(providerContext));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (controller) controller.abort();
          reject(new Error('PROVIDER_TIMEOUT'));
        }, timeoutMs);
      });
      const raw = await Promise.race([work, timeout]);
      clearTimeout(timer);
      const elapsedMs = Math.max(0, now() - started);
      const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.streams) ? raw.streams : []);
      const seen = new Set();
      const streams = [];
      items.forEach(item => {
        const normalized = normalizeStream(item, provider);
        if (!normalized || seen.has(normalized.url)) return;
        seen.add(normalized.url);
        streams.push(normalized);
      });
      state.failures = 0;
      state.successes += streams.length ? 1 : 0;
      state.empty += streams.length ? 0 : 1;
      state.lastStatus = streams.length ? 'ok' : 'empty';
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs :
        state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
      streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
      return { providerId: provider.id, status: state.lastStatus, elapsedMs, streams };
    } catch (error) {
      if (timer) clearTimeout(timer);
      const elapsedMs = Math.max(0, now() - started);
      state.failures++;
      state.errors++;
      if (timedOut) state.timeouts++;
      state.lastStatus = timedOut ? 'timeout' : 'error';
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs :
        state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
      if (state.failures >= failureThreshold) state.openUntil = now() + cooldownMs;
      console.error('[CEE ENGINE]', provider.id, state.lastStatus, error && error.message || error);
      return { providerId: provider.id, status: state.lastStatus, elapsedMs, streams: [] };
    }
  }

  async function getStreams(context) {
    const results = await Promise.all(providers.map(provider => runProvider(provider, context || {})));
    const seen = new Set();
    const streams = [];
    results.forEach(result => result.streams.forEach(stream => {
      if (seen.has(stream.url)) return;
      seen.add(stream.url);
      streams.push(stream);
    }));
    streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
    return { streams, providers: results };
  }

  function getHealth() {
    const snapshot = {};
    health.forEach((state, id) => {
      snapshot[id] = {
        attempts: state.attempts, successes: state.successes, empty: state.empty,
        errors: state.errors, timeouts: state.timeouts, failures: state.failures,
        circuitOpen: state.openUntil > now(), retryAt: state.openUntil > now() ? state.openUntil : null,
        latencyEwmaMs: state.latencyEwmaMs, lastStatus: state.lastStatus
      };
    });
    return snapshot;
  }
  return { getStreams, getHealth };
}

const DEFAULT_BASE = 'https://cee.buzz';
const API_SUFFIX = '/api/android';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
const cache = new Map();

function baseUrl() {
  return DEFAULT_BASE;
}

function tmdbKey() {
  const root = typeof globalThis !== 'undefined' ? globalThis : {};
  const injected = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : root.TMDB_API_KEY;
  return String(injected || '').trim();
}

function cached(key, loader, ttl) {
  const now = Date.now();
  const previous = cache.get(key);
  if (previous && now - previous.time < ttl) return previous.value;

  const pending = Promise.resolve().then(loader).catch(function (error) {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { time: now, value: pending });
  return pending;
}

function request(url, options) {
  const opts = options || {};
  const headers = Object.assign({
    Accept: 'application/json, text/plain, */*',
    'User-Agent': USER_AGENT,
    Referer: baseUrl() + '/',
    Origin: baseUrl()
  }, opts.headers || {});

  return fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body
  }).then(function (response) {
    return response.text().then(function (body) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' ' + url + ' :: ' + body.slice(0, 500));
      }
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error('Invalid JSON from ' + url + ' :: ' + body.slice(0, 250));
      }
    });
  });
}

function api(path) {
  return request(baseUrl() + API_SUFFIX + '/' + String(path).replace(/^\/+/, ''));
}

function probe(url) {
  return fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': USER_AGENT }
  }).then(function (response) {
    return !!response && response.ok;
  }).catch(function () {
    return false;
  });
}

function diagnoseNetwork() {
  return cached('network-diagnostic', function () {
    return probe(baseUrl()).then(function (hostOk) {
      if (hostOk) {
        console.log('[CEE NETWORK] CEE_HOST_REACHABLE');
        return 'CEE_HOST_REACHABLE';
      }
      return probe('https://api.github.com/zen').then(function (internetOk) {
        const state = internetOk ? 'CEE_HOST_UNREACHABLE_INTERNET_OK' : 'NETWORK_CONNECTIVITY_UNCLEAR';
        console.log('[CEE NETWORK] ' + state);
        return state;
      });
    });
  }, 30000);
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const keys = ['data', 'results', 'videos', 'items', 'list'];
  for (let i = 0; i < keys.length; i++) {
    if (Array.isArray(value[keys[i]])) return value[keys[i]];
  }
  if (value.data && typeof value.data === 'object') {
    for (let j = 0; j < keys.length; j++) {
      if (Array.isArray(value.data[keys[j]])) return value.data[keys[j]];
    }
  }
  return [];
}

function objectFrom(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value[0] || null;
  if (value.data && !Array.isArray(value.data) && typeof value.data === 'object') return value.data;
  return value;
}

function normalizeTitle(value) {
  let text = String(value || '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
  if (typeof text.normalize === 'function') {
    text = text.normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '');
  }
  return text.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleScore(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = a.split(' ');
  const bb = b.split(' ');
  let common = 0;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] && bb.indexOf(aa[i]) !== -1) common++;
  }
  return (2 * common) / (aa.length + bb.length);
}

function imdbFrom(value) {
  const match = String(value || '').match(/tt\d{5,12}/i);
  return match ? match[0].toLowerCase() : null;
}

function malFrom(value) {
  const match = String(value || '').match(/myanimelist\.net\/anime\/(\d+)/i);
  return match ? match[1] : null;
}

function yearFrom(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

function mediaKind(type) {
  return String(type || 'movie').toLowerCase() === 'movie' ? 'movie' : 'tv';
}

function parseDirectId(value) {
  const match = String(value || '').trim().match(/^(?:cee_|cee:)(\d+)(?:[:_](\d+)[:_](\d+))?$/i);
  if (!match) return null;
  return {
    directNb: match[1],
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  };
}

function parseInputId(value) {
  const raw = String(value || '').trim();
  const episodeMatch = raw.match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (episodeMatch) {
    return {
      imdbId: episodeMatch[1].toLowerCase(),
      season: episodeMatch[2] ? Number(episodeMatch[2]) : null,
      episode: episodeMatch[3] ? Number(episodeMatch[3]) : null
    };
  }
  const malMatch = raw.match(/^mal:(\d+)(?::(\d+))?$/i);
  if (malMatch) {
    return { malId: malMatch[1], absoluteEpisode: malMatch[2] ? Number(malMatch[2]) : null };
  }
  const direct = parseDirectId(raw);
  if (direct) return direct;
  return {
    tmdbId: raw.replace(/^(tmdb:|movie:|series:|tv:)/i, '').split(':')[0],
    season: null,
    episode: null
  };
}

function resolveMal(malId, absoluteEpisode) {
  return cached('mal-meta-' + malId, function () {
    return request('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Nuvio-CEE/2.0' },
      body: JSON.stringify({
        query: 'query($idMal: Int){Media(idMal:$idMal,type:ANIME){startDate{year} title{romaji english native}}}',
        variables: { idMal: Number(malId) }
      })
    }).then(function (response) {
      const media = response && response.data && response.data.Media;
      if (!media) throw new Error('No AniList metadata for MAL ' + malId);
      const titles = [];
      if (media.title) {
        [media.title.english, media.title.romaji, media.title.native].forEach(function (title) {
          if (title && titles.indexOf(title) === -1) titles.push(title);
        });
      }
      return {
        malId: String(malId),
        imdbId: null,
        titles: titles,
        year: media.startDate && media.startDate.year ? String(media.startDate.year) : null,
        absoluteEpisode: absoluteEpisode
      };
    });
  }, 600000);
}

function resolveMetadata(parsed, type) {
  if (parsed.directNb) return Promise.resolve(parsed);
  if (parsed.malId) return resolveMal(parsed.malId, parsed.absoluteEpisode);

  const kind = mediaKind(type);
  if (parsed.imdbId) {
    return cached('imdb-meta-' + kind + '-' + parsed.imdbId, function () {
      const cinemetaType = kind === 'tv' ? 'series' : 'movie';
      return request('https://v3-cinemeta.strem.io/meta/' + cinemetaType + '/' +
        encodeURIComponent(parsed.imdbId) + '.json').then(function (response) {
        const meta = response && response.meta;
        if (!meta) throw new Error('No Cinemeta metadata for ' + parsed.imdbId);
        const titles = [];
        [meta.name, meta.original_name, meta.english_name].forEach(function (title) {
          if (title && titles.indexOf(String(title).trim()) === -1) titles.push(String(title).trim());
        });
        return {
          imdbId: parsed.imdbId,
          titles: titles,
          year: yearFrom(meta.year || meta.released),
          season: parsed.season,
          episode: parsed.episode
        };
      });
    }, 600000);
  }

  const key = tmdbKey();
  if (!key) {
    console.error('[CEE] TMDB_API_KEY is not available in the Nuvio runtime');
    return Promise.resolve({ titles: [], year: null });
  }
  const tmdbId = String(parsed.tmdbId || '');
  if (!/^\d+$/.test(tmdbId)) return Promise.resolve({ titles: [], year: null });

  return cached('meta-' + kind + '-' + tmdbId, function () {
    const url = 'https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(tmdbId) +
      '?api_key=' + encodeURIComponent(key) + '&append_to_response=external_ids,translations';
    return request(url).then(function (details) {
      const external = details.external_ids || {};
      const resolvedImdb = imdbFrom(details.imdb_id) || imdbFrom(external.imdb_id);
      const titles = [];
      [details.title || details.name, details.original_title || details.original_name].forEach(function (title) {
        if (title && titles.indexOf(String(title).trim()) === -1) titles.push(String(title).trim());
      });
      const translations = details.translations && details.translations.translations || [];
      for (let i = 0; i < translations.length; i++) {
        const item = translations[i];
        const title = item && item.iso_639_1 === 'ar' && item.data && (item.data.title || item.data.name);
        if (title && titles.indexOf(String(title).trim()) === -1) titles.push(String(title).trim());
      }
      return {
        tmdbId: tmdbId,
        imdbId: resolvedImdb,
        titles: titles,
        year: yearFrom(details.release_date || details.first_air_date),
        season: parsed.season,
        episode: parsed.episode
      };
    });
  }, 600000);
}
function getCandidateTitles(item) {
  return [
    item && item.en_title, item && item.ar_title, item && item.other_title,
    item && item.enTitle, item && item.arTitle, item && item.title, item && item.name
  ].filter(Boolean).map(String);
}

function searchCee(meta, type) {
  const titles = (meta.titles || []).filter(Boolean);
  if (!titles.length && meta.imdbId) titles.push(meta.imdbId);
  if (!titles.length && meta.malId) titles.push('mal:' + meta.malId);
  if (!titles.length) return Promise.resolve(null);

  const kind = mediaKind(type);
  const apiType = kind === 'movie' ? 'movies' : 'series';
  const expectedKind = kind === 'movie' ? 1 : 2;
  const queries = [];
  const addQuery = function (value) {
    const term = String(value || '').trim();
    if (term && queries.indexOf(term) === -1) queries.push(term);
  };

  addQuery(titles[0]);
  if (meta.year) addQuery(titles[0] + ' ' + meta.year);
  for (let i = 1; i < Math.min(titles.length, 3); i++) addQuery(titles[i]);
  if (queries.length > 4) queries.length = 4;

  const yearRange = meta.year
    ? String(Number(meta.year) - 1) + ',' + String(Number(meta.year) + 1)
    : '1900,' + new Date().getFullYear();

  function searchOne(term) {
    const encoded = encodeURIComponent(term);
    const path = 'AdvancedSearch?level=0&videoTitle=' + encoded +
      '&staffTitle=' + encoded + '&year=' + encodeURIComponent(yearRange) +
      '&page=0&type=' + apiType + '&itemsPerPage=12';
    return cached('search-' + apiType + '-' + normalizeTitle(term), function () {
      return api(path).then(listFrom);
    }, 600000).catch(function (error) {
      console.error('[CEE SEARCH]', term, error.message);
      return [];
    });
  }

  function rankMatches(items) {
    const unique = new Map();
    items.forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (item) {
        const id = item && (item.nb != null ? item.nb : item.id);
        if (id != null && String(id) !== '' && !unique.has(String(id))) {
          unique.set(String(id), item);
        }
      });
    });

    const ranked = [];
    unique.forEach(function (item) {
      const itemKind = Number(item.kind);
      if (itemKind && itemKind !== expectedKind) return;

      const candidateImdb = imdbFrom(item.imdbUrlRef || item.imdb_url_ref);
      const candidateMal = malFrom(item.imdbUrlRef || item.imdb_url_ref);
      if (meta.imdbId && candidateImdb && candidateImdb !== meta.imdbId) return;
      if (meta.malId && candidateMal && candidateMal !== String(meta.malId)) return;

      const candidateTitles = getCandidateTitles(item);
      let score = 0;
      let exact = false;
      candidateTitles.forEach(function (candidate) {
        const normalized = normalizeTitle(candidate);
        (meta.titles || []).forEach(function (wanted) {
          if (normalized && normalized === normalizeTitle(wanted)) exact = true;
          score = Math.max(score, titleScore(candidate, wanted));
        });
      });

      const candidateYear = yearFrom(item.year || item.releaseYear || item.releaseDate);
      if (meta.year && candidateYear) {
        const difference = Math.abs(Number(meta.year) - Number(candidateYear));
        if (difference > 1) return;
        if (difference === 0) score += 0.12;
      }

      const exactExternal = (!!meta.imdbId && candidateImdb === meta.imdbId) ||
        (!!meta.malId && candidateMal === String(meta.malId));
      if (!exactExternal && !exact && score < 0.72) return;

      ranked.push({
        id: String(item.nb != null ? item.nb : item.id),
        score: exactExternal ? 2 : (exact ? 1.5 : score),
        exactExternal: exactExternal
      });
    });

    ranked.sort(function (left, right) { return right.score - left.score; });
    if (!ranked.length) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0];
  }

  // Search title variants concurrently instead of waiting for each slow CEE
  // response before issuing the next query. The cache still coalesces repeats.
  return Promise.all(queries.map(searchOne)).then(function (results) {
    const best = rankMatches(results);
    if (!best) {
      console.log('[CEE SEARCH] no confident match', titles.join(' / '), meta.year || '');
      return null;
    }
    console.log('[CEE MATCH]', best.id, best.exactExternal ? 'exact external ID' : 'score: ' + best.score);
    return best.id;
  });
}
function numberOf(value) {
  const match = String(value == null ? '' : value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function resolveEpisode(seriesId, season, episode) {
  if (season == null || episode == null) return Promise.resolve(null);
  return cached('episodes-' + seriesId, function () {
    return api('videoSeason/id/' + encodeURIComponent(seriesId)).then(listFrom);
  }, 600000).then(function (episodes) {
    const matches = episodes.filter(function (item) {
      const itemSeason = numberOf(item && (item.season != null ? item.season : item.seasonNumber));
      const itemEpisode = numberOf(item && (item.episodeNummer != null
        ? item.episodeNummer
        : (item.episodeNumber != null ? item.episodeNumber : item.episode)));
      return itemSeason === Number(season) && itemEpisode === Number(episode) &&
        item.nb != null && String(item.nb) !== '';
    });
    if (matches.length !== 1) {
      console.log('[CEE EPISODE] exact match required; found:', matches.length,
        'season:', season, 'episode:', episode);
      return null;
    }
    return String(matches[0].nb);
  });
}

function getDetails(videoId) {
  return cached('details-' + videoId, function () {
    return api('allVideoInfo/id/' + encodeURIComponent(videoId)).then(objectFrom);
  }, 600000);
}

function getVideoFiles(videoId) {
  return cached('player-' + videoId, function () {
    return api('transcoddedFiles/id/' + encodeURIComponent(videoId)).then(listFrom).then(function (files) {
      if (files.length) return files;
      console.log('[CEE PLAYER] primary endpoint empty; trying alternate spelling');
      return api('transcodedFiles/id/' + encodeURIComponent(videoId)).then(listFrom);
    }).catch(function (firstError) {
      console.log('[CEE PLAYER] primary endpoint failed; trying alternate spelling:', firstError.message);
      return api('transcodedFiles/id/' + encodeURIComponent(videoId)).then(listFrom);
    });
  }, 30000);
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.indexOf('//') === 0) return 'https:' + raw;
  if (raw.charAt(0) === '/') return baseUrl() + raw;
  return baseUrl() + '/' + raw.replace(/^\.?\//, '');
}

function safeHeaderMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const headers = {};
  Object.keys(value).forEach(function (key) {
    const name = String(key || '').trim();
    const headerValue = value[key];
    if (!name || typeof headerValue !== 'string') return;
    const cleanValue = headerValue.trim();
    if (!cleanValue || /[\r\n]/.test(name) || /[\r\n]/.test(cleanValue)) return;
    headers[name] = cleanValue;
  });
  return Object.keys(headers).length ? headers : null;
}

function playbackProxyHeaders(file) {
  const requestHeaders = safeHeaderMap(file && file.requestHeaders);
  const responseHeaders = safeHeaderMap(file && file.responseHeaders);
  if (!requestHeaders && !responseHeaders) return null;
  const result = {};
  if (requestHeaders) result.request = requestHeaders;
  if (responseHeaders) result.response = responseHeaders;
  return result;
}

function qualityLabel(value) {
  const raw = String(value || '').toLowerCase();
  if (/2160|4k/.test(raw)) return '4K';
  if (/1440|2k/.test(raw)) return '1440p';
  if (/1080/.test(raw)) return '1080p';
  if (/720/.test(raw)) return '720p';
  if (/576/.test(raw)) return '576p';
  if (/480/.test(raw)) return '480p';
  if (/360/.test(raw)) return '360p';
  if (/240/.test(raw)) return '240p';
  return String(value || 'HD').trim();
}

function qualityRank(value) {
  const label = qualityLabel(value);
  const ranks = { '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, '360p': 360, '240p': 240 };
  return ranks[label] || 0;
}

function buildStreams(files, details, videoId, type, season, episode) {
  const seen = new Set();
  const streams = [];

  files.forEach(function (file) {
    const url = normalizeUrl(file && (file.videoUrl || file.url));
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);

    const quality = qualityLabel(file.resolution || file.name || file.container);
    const stream = {
      name: 'CEE · ' + quality,
      title: quality + ' • CEE',
      url: url,
      _rank: qualityRank(quality)
    };
    const proxyHeaders = playbackProxyHeaders(file);
    if (proxyHeaders) {
      stream.behaviorHints = { proxyHeaders: proxyHeaders };
    }
    streams.push(stream);
  });

  streams.sort(function (a, b) { return b._rank - a._rank; });
  streams.forEach(function (stream) { delete stream._rank; });
  return streams;
}

function fetchCeeStreams(type, id, season, episode) {
  const kind = mediaKind(type);
  const parsed = parseInputId(id);
  const targetSeason = parsed.season != null ? parsed.season : season;
  const targetEpisode = parsed.episode != null ? parsed.episode : (parsed.absoluteEpisode != null ? parsed.absoluteEpisode : episode);

  return resolveMetadata(parsed, kind).then(function (meta) {
    if (meta.directNb) return { meta: meta, baseId: meta.directNb };
    return searchCee(meta, kind).then(function (baseId) {
      return { meta: meta, baseId: baseId };
    });
  }).then(function (resolved) {
    if (!resolved.baseId) return [];
    const videoIdPromise = kind === 'tv'
      ? resolveEpisode(resolved.baseId, targetSeason, targetEpisode)
      : Promise.resolve(resolved.baseId);
    return videoIdPromise.then(function (videoId) {
      if (!videoId) return [];
      // Playback needs the player file list only. The allVideoInfo endpoint
      // is metadata (titles/subtitles) and is not used to construct stream URLs.
      // Do not make playback wait for an unrelated request.
      return getVideoFiles(videoId).then(function (files) {
        if (!files || !files.length) return [];
        return buildStreams(files, null, videoId, kind, targetSeason, targetEpisode);
      });
    });
  }).catch(function (error) {
    const message = String(error && error.message || error);
    console.error('[CEE STREAM ERROR]', kind, id, message);
    if (/fetch failed|networkerror|enotfound|econnrefused|etimedout|network request failed/i.test(message)) {
      return diagnoseNetwork().then(function () { return []; });
    }
    return [];
  });
}

// CEE-specific adapter: the provider engine owns orchestration; this adapter
// owns only the CEE lookup and stream extraction path.
const ceeProvider = {
  id: 'cee',
  name: 'CEE',
  priority: 100,
  getStreams: function (context) {
    return fetchCeeStreams(context.mediaType, context.id, context.season, context.episode);
  }
};
const ceeEngine = createProviderEngine({
  providers: [ceeProvider],
  providerTimeoutMs: 45000,
  failureThreshold: 2,
  cooldownMs: 30000
});

function getStreams(input, mediaType, season, episode) {
  const args = input && typeof input === 'object'
    ? input
    : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };
  const id = args.tmdbId != null ? args.tmdbId : (args.id != null ? args.id : args.imdbId);
  return ceeEngine.getStreams({
    mediaType: args.mediaType || args.type || 'movie',
    id: id,
    season: args.season,
    episode: args.episode
  }).then(function (result) {
    return result.streams;
  });
}

function getEngineHealth() {
  return ceeEngine.getHealth();
}

module.exports = { getStreams: getStreams, getEngineHealth: getEngineHealth };
