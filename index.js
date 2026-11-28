'use strict';

/*
 * CEE Nuvio provider — independent implementation.
 * Uses CEE's public web API; no CinemaBox or Cinemana dependency.
 */


// Bundled CEE provider engine. Kept in sync with engine/provider-engine.js for Nuvio's single-file runtime.
'use strict';

const QUALITY = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, '360p': 360, '240p': 240 };

function normalizeQuality(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 'Video';
  let match = raw.match(/^(?:4\s*k|uhd)(?:\s+(.+))?$/i);
  if (match) return '2160p' + (match[1] ? ' ' + match[1].trim() : '');
  match = raw.match(/^(\d{3,4})\s*p(?:\s+(.+))?$/i);
  return match ? match[1] + 'p' + (match[2] ? ' ' + match[2].trim() : '') : raw;
}

function qualityRank(value) {
  const match = normalizeQuality(value).match(/^(\d{3,4})p/i);
  return match ? Number(match[1]) : (QUALITY[String(value).toLowerCase()] || -1);
}

function validStreamUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /\s|\\/.test(value)) return false;
  const protocolEnd = value.indexOf('://');
  if (protocolEnd < 0) return false;
  const protocol = value.slice(0, protocolEnd).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') return false;
  const authority = value.slice(protocolEnd + 3).split(/[/?#]/, 1)[0];
  if (!authority) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch (_) { return false; }
}

function streamRejectionReason(stream) {
  if (!stream || typeof stream !== 'object') return 'invalid-item';
  if (typeof stream.url !== 'string' || !stream.url) return 'missing-url';
  if (!validStreamUrl(stream.url)) return 'invalid-url';
  return null;
}

function normalizeStream(stream, provider) {
  if (!stream || !validStreamUrl(stream.url)) return null;
  const quality = normalizeQuality(stream.quality || stream.resolution);
  const label = String(provider.name || provider.id) + ' ' + quality;
  const output = {
    name: String(stream.name || label),
    title: String(stream.title || label),
    url: stream.url,
    quality: quality
  };
  if (stream.behaviorHints && typeof stream.behaviorHints === 'object') output.behaviorHints = stream.behaviorHints;
  if (stream.language) output.language = String(stream.language);
  if (Array.isArray(stream.subtitles) && stream.subtitles.length) output.subtitles = stream.subtitles.slice();
  if (Number.isFinite(Number(stream.sizeBytes)) && Number(stream.sizeBytes) > 0) output.sizeBytes = Number(stream.sizeBytes);
  if (Number.isFinite(Number(stream.seeders)) && Number(stream.seeders) >= 0) output.seeders = Number(stream.seeders);
  return output;
}

function createProviderEngine(options) {
  const config = options || {};
  const providers = Array.isArray(config.providers) ? config.providers.slice() : [];
  const concurrency = Math.max(1, Math.floor(config.maxConcurrency || 3));
  const defaultTimeoutMs = Math.max(100, Number(config.providerTimeoutMs) || 25000);
  const failureThreshold = Math.max(1, Math.floor(config.failureThreshold || 2));
  const cooldownMs = Math.max(100, Number(config.cooldownMs) || 30000);
  const maxCooldownMs = Math.max(cooldownMs, Number(config.maxCooldownMs) || 300000);
  const now = config.now || Date.now;
  const schedule = config.setTimeout || (typeof setTimeout === 'function' ? setTimeout : function () { return null; });
  const cancel = config.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
  const health = new Map();

  providers.forEach(provider => {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(provider.id || '')) ||
        typeof provider.getStreams !== 'function') throw new TypeError('Invalid provider contract');
    if (!health.has(provider.id)) health.set(provider.id, {
      failures: 0, openUntil: 0, attempts: 0, successes: 0, validStreams: 0,
      emptyResponses: 0, errorCount: 0, timeoutCount: 0, rejectedStreams: 0,
      latencyEwmaMs: null, lastStatus: 'never', lastCooldownMs: 0
    });
  });

  async function runOne(provider, context) {
    const state = health.get(provider.id);
    if (provider.enabled === false) return { providerId: provider.id, status: 'disabled', streams: [] };
    if (typeof provider.supports === 'function' && !provider.supports(context)) {
      return { providerId: provider.id, status: 'unsupported', streams: [] };
    }
    if (state.openUntil > now()) return { providerId: provider.id, status: 'circuit-open', streams: [] };
    const providerTimeoutMs = Math.max(100, Number(provider.timeoutMs) || defaultTimeoutMs);
    const inheritedDeadline = Number.isFinite(context.deadline) ? context.deadline : Infinity;
    const deadline = Math.min(inheritedDeadline, now() + providerTimeoutMs);
    if (deadline <= now()) return { providerId: provider.id, status: 'deadline-exceeded', streams: [] };

    const startedAt = now();
    state.attempts += 1;
    let timer;
    let timedOut = false;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const providerContext = Object.assign({}, context, {
        providerId: provider.id, deadline: deadline,
        signal: controller ? controller.signal : undefined
      });
      const work = Promise.resolve().then(() => provider.getStreams(providerContext));
      let result;
      if (provider.skipTimeoutTimer === true) {
        result = await work;
      } else {
        const timeout = new Promise((_, reject) => {
          timer = schedule(() => {
            timedOut = true;
            if (controller) controller.abort();
            reject(new Error('PROVIDER_TIMEOUT'));
          }, Math.max(1, deadline - now()));
        });
        result = await Promise.race([work, timeout]);
        cancel(timer);
      }

      const elapsedMs = Math.max(0, now() - startedAt);
      state.failures = 0;
      state.openUntil = 0;
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
      const raw = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);
      const streams = [];
      const rejectionReasons = {};
      const seen = new Set();
      raw.forEach(item => {
        const normalized = normalizeStream(item, provider);
        if (normalized && !seen.has(normalized.url)) {
          seen.add(normalized.url);
          streams.push(normalized);
        } else if (!normalized) {
          const reason = streamRejectionReason(item) || 'invalid-stream';
          rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
        }
      });
      const rejectedStreams = raw.length - streams.length;
      state.rejectedStreams += rejectedStreams;
      if (streams.length) state.successes += 1;
      else state.emptyResponses += 1;
      state.lastStatus = streams.length ? 'ok' : 'empty';
      state.validStreams += streams.length;
      streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
      return { providerId: provider.id, status: state.lastStatus, elapsedMs, rawStreams: raw.length,
        rejectedStreams, rejectionReasons, streams };
    } catch (error) {
      if (timer !== undefined) cancel(timer);
      const elapsedMs = Math.max(0, now() - startedAt);
      state.failures += 1;
      state.errorCount += 1;
      if (timedOut) state.timeoutCount += 1;
      state.lastStatus = timedOut ? 'timeout' : 'error';
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
      if (state.failures >= failureThreshold) {
        const exponent = Math.min(10, state.failures - failureThreshold);
        state.lastCooldownMs = Math.min(maxCooldownMs, cooldownMs * Math.pow(2, exponent));
        state.openUntil = now() + state.lastCooldownMs;
      }
      console.error('[CEE ENGINE]', provider.id, state.lastStatus, error && error.message || error);
      return { providerId: provider.id, status: state.lastStatus, elapsedMs, streams: [] };
    }
  }

  async function getStreams(context) {
    const input = context || {};
    const results = new Array(providers.length);
    const primaryIndexes = [];
    const fallbackIndexes = [];
    providers.forEach((provider, index) => {
      (provider.fallbackOnlyWhenEmpty === true ? fallbackIndexes : primaryIndexes).push(index);
    });
    async function runIndexes(indexes) {
      let cursor = 0;
      async function worker() {
        while (true) {
          const position = cursor++;
          if (position >= indexes.length) return;
          const index = indexes[position];
          results[index] = await runOne(providers[index], input);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, () => worker()));
    }
    await runIndexes(primaryIndexes);
    const primaryHasStreams = primaryIndexes.some(index => results[index] && results[index].streams.length > 0);
    if (!primaryHasStreams && fallbackIndexes.length) await runIndexes(fallbackIndexes);
    fallbackIndexes.forEach(index => {
      if (!results[index]) results[index] = { providerId: providers[index].id, status: 'skipped-primary-success', streams: [] };
    });

    const seen = new Set();
    const streams = [];
    results.forEach(result => (result && result.streams || []).forEach(stream => {
      if (seen.has(stream.url)) return;
      seen.add(stream.url);
      streams.push(stream);
    }));
    streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    return { streams, providers: results };
  }

  function getHealth() {
    const snapshot = {};
    health.forEach((state, id) => {
      snapshot[id] = {
        failures: state.failures, circuitOpen: state.openUntil > now(),
        retryAt: state.openUntil > now() ? state.openUntil : null,
        cooldownMs: state.lastCooldownMs, attempts: state.attempts, successes: state.successes,
        successRate: state.attempts ? state.successes / state.attempts : null,
        productiveRate: state.attempts ? state.successes / state.attempts : null,
        emptyResponses: state.emptyResponses, errorCount: state.errorCount,
        timeoutCount: state.timeoutCount, rejectedStreams: state.rejectedStreams,
        validStreams: state.validStreams, latencyEwmaMs: state.latencyEwmaMs,
        lastStatus: state.lastStatus
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

const CACHE_MAX_ENTRIES = 500;

function cached(key, loader, ttl) {
  const now = Date.now();
  const previous = cache.get(key);
  if (previous && (previous.pending || now < previous.expiresAt)) {
    cache.delete(key);
    cache.set(key, previous);
    return previous.value;
  }
  if (previous) cache.delete(key);

  const entry = { pending: true, expiresAt: 0, value: null };
  const value = Promise.resolve().then(loader).then(function (result) {
    if (cache.get(key) === entry) {
      entry.pending = false;
      entry.expiresAt = Date.now() + Math.max(0, Number(ttl) || 0);
    }
    return result;
  }).catch(function (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  entry.value = value;
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === key && cache.size === 1) break;
    cache.delete(oldestKey);
  }
  return value;
}

function ensureBudget(deadline, stage) {
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw new Error('CEE time budget exceeded before ' + stage);
}

function request(url, options) {
  const opts = options || {};
  ensureBudget(opts.deadline, 'HTTP request');
  const startedAt = Date.now();
  const safeUrl = String(url).replace(/([?&]api_key=)[^&]*/gi, '$1[REDACTED]');
  const requestLabel = (function () {
    try { const parsed = new URL(url); return parsed.hostname + parsed.pathname; }
    catch (_) { return 'unknown-endpoint'; }
  })();
  const headers = Object.assign({
    Accept: 'application/json, text/plain, */*',
    'User-Agent': USER_AGENT,
    Referer: baseUrl() + '/',
    Origin: baseUrl()
  }, opts.headers || {});
  const fetchOptions = {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body
  };
  if (opts.signal) fetchOptions.signal = opts.signal;

  return fetch(url, fetchOptions).then(function (response) {
    return response.text().then(function (body) {
      ensureBudget(opts.deadline, 'HTTP response body');
      console.log('[CEE HTTP]', response.status, Date.now() - startedAt, 'ms', requestLabel);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' ' + safeUrl + ' :: ' + body.slice(0, 500));
      }
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error('Invalid JSON from ' + safeUrl + ' :: ' + body.slice(0, 250));
      }
    });
  }).catch(function (error) {
    console.log('[CEE HTTP]', 'failed', Date.now() - startedAt, 'ms', requestLabel);
    throw error;
  });
}

function api(path, options) {
  return request(baseUrl() + API_SUFFIX + '/' + String(path).replace(/^\/+/, ''), options);
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

function resolveMal(malId, absoluteEpisode, signal, deadline) {
  return cached('mal-meta-' + malId, function () {
    return request('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Nuvio-CEE/2.0' },
      body: JSON.stringify({
        query: 'query($idMal: Int){Media(idMal:$idMal,type:ANIME){startDate{year} title{romaji english native}}}',
        variables: { idMal: Number(malId) }
      }),
      signal: signal,
      deadline: deadline
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

function metadataFromInput(input, parsed) {
  const supplied = input && input.meta && typeof input.meta === 'object' ? input.meta : input || {};
  const titles = [];
  [supplied.name, supplied.title, supplied.original_name, supplied.original_title,
    supplied.originalTitle, supplied.english_name, supplied.englishName,
    supplied.arabic_name, supplied.ar_title].forEach(function (value) {
    const title = String(value || '').trim();
    if (title && titles.indexOf(title) === -1) titles.push(title);
  });
  const year = yearFrom(supplied.year || supplied.release_date || supplied.releaseDate || supplied.released);
  if (!titles.length) return null;
  return {
    tmdbId: parsed.tmdbId || null,
    imdbId: parsed.imdbId || imdbFrom(supplied.imdb_id || supplied.imdbId || supplied.imdb),
    malId: parsed.malId || null,
    titles: titles,
    year: year,
    season: parsed.season,
    episode: parsed.episode,
    absoluteEpisode: parsed.absoluteEpisode
  };
}

function resolveMetadata(parsed, type, suppliedMeta, signal, deadline) {
  if (parsed.directNb) return Promise.resolve(parsed);
  if (suppliedMeta && suppliedMeta.titles && suppliedMeta.titles.length) {
    console.log('[CEE METADATA] using Nuvio-supplied metadata; skipping external metadata request');
    return Promise.resolve(Object.assign({}, suppliedMeta, {
      imdbId: parsed.imdbId || suppliedMeta.imdbId || null,
      malId: parsed.malId || suppliedMeta.malId || null,
      tmdbId: parsed.tmdbId || suppliedMeta.tmdbId || null,
      season: parsed.season != null ? parsed.season : suppliedMeta.season,
      episode: parsed.episode != null ? parsed.episode : suppliedMeta.episode
    }));
  }
  if (parsed.malId) return resolveMal(parsed.malId, parsed.absoluteEpisode, signal, deadline);

  const kind = mediaKind(type);
  if (parsed.imdbId) {
    return cached('imdb-meta-' + kind + '-' + parsed.imdbId, function () {
      const cinemetaType = kind === 'tv' ? 'series' : 'movie';
      return request('https://v3-cinemeta.strem.io/meta/' + cinemetaType + '/' +
        encodeURIComponent(parsed.imdbId) + '.json', { signal: signal, deadline: deadline }).then(function (response) {
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
    return request(url, { signal: signal, deadline: deadline }).then(function (details) {
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

function searchCee(meta, type, signal, deadline) {
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

  // CinemaBox-style search: primary title first, then only the fallbacks
  // needed to establish a confident match. Do not wait for slow aliases.
  addQuery(titles[0]);
  if (meta.year) addQuery(titles[0] + ' ' + meta.year);
  for (let i = 1; i < Math.min(titles.length, 4); i++) addQuery(titles[i]);

  const yearRange = meta.year
    ? String(Number(meta.year) - 1) + ',' + String(Number(meta.year) + 1)
    : '1900,' + new Date().getFullYear();

  function searchOne(term) {
    const encoded = encodeURIComponent(term);
    const path = 'AdvancedSearch?level=0&videoTitle=' + encoded +
      '&staffTitle=' + encoded + '&year=' + encodeURIComponent(yearRange) +
      '&page=0&type=' + apiType + '&itemsPerPage=12';
    return cached('search-' + apiType + '-' + normalizeTitle(term) + '-' + yearRange, function () {
      return api(path, { signal: signal, deadline: deadline }).then(listFrom);
    }, 600000).catch(function (error) {
      console.error('[CEE SEARCH]', term, error.message);
      return [];
    });
  }

  function rankMatches(lists) {
    const unique = new Map();
    lists.forEach(function (list) {
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
      let yearMatches = false;
      let yearCompatible = true;
      if (meta.year && candidateYear) {
        const difference = Math.abs(Number(meta.year) - Number(candidateYear));
        if (difference > 1) return;
        yearMatches = difference === 0;
        yearCompatible = difference <= 1;
        if (yearMatches) score += 0.12;
      }

      const exactExternal = (!!meta.imdbId && candidateImdb === meta.imdbId) ||
        (!!meta.malId && candidateMal === String(meta.malId));
      if (!exactExternal && !exact && score < 0.72) return;

      ranked.push({
        id: String(item.nb != null ? item.nb : item.id),
        score: exactExternal ? 2 : (exact ? 1.5 : score),
        exactExternal: exactExternal,
        exactTitle: exact,
        yearMatches: yearMatches,
        yearCompatible: yearCompatible
      });
    });

    ranked.sort(function (left, right) {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.id).localeCompare(String(right.id));
    });
    if (!ranked.length) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0];
  }

  function isStrong(match) {
    return !!match && (match.exactExternal || (match.exactTitle && match.yearCompatible));
  }

  console.log('[CEE SEARCH] primary-first, parallel fallbacks:', queries.length,
    'primary:', queries[0]);
  const primaryStarted = Date.now();
  return searchOne(queries[0]).then(function (primaryItems) {
    const primaryMatch = rankMatches([primaryItems]);
    console.log('[CEE SEARCH TRACE] primary elapsedMs:', Date.now() - primaryStarted,
      'results:', primaryItems.length, 'best:', primaryMatch ? primaryMatch.id : 'none',
      'score:', primaryMatch ? primaryMatch.score : 'n/a');
    if (isStrong(primaryMatch)) {
      console.log('[CEE SEARCH STOP] strong primary first-page match', primaryMatch.id,
        primaryMatch.exactExternal ? 'external-id' : 'exact-title');
      return primaryMatch.id;
    }

    if (queries.length === 1) return primaryMatch ? primaryMatch.id : null;
    const fallbackQueries = queries.slice(1);
    const fallbackStarted = Date.now();
    return Promise.all(fallbackQueries.map(function (term) {
      return searchOne(term).then(function (items) {
        const match = rankMatches([items]);
        console.log('[CEE SEARCH TRACE] fallback', term, 'elapsedMs:', Date.now() - fallbackStarted,
          'results:', items.length, 'best:', match ? match.id : 'none',
          'score:', match ? match.score : 'n/a');
        return { items: items, match: match };
      });
    })).then(function (fallbackResults) {
      const allLists = [primaryItems].concat(fallbackResults.map(function (result) {
        return result.items;
      }));
      const bestMatch = rankMatches(allLists);
      const strongFallback = fallbackResults.map(function (result) { return result.match; })
        .filter(isStrong).sort(function (a, b) { return b.score - a.score; })[0];
      console.log('[CEE SEARCH TRACE] parallel fallbacks completed in',
        Date.now() - fallbackStarted, 'ms; count:', fallbackQueries.length);
      return strongFallback ? strongFallback.id : (bestMatch ? bestMatch.id : null);
    });
  }).then(function (id) {
    if (id) {
      console.log('[CEE MATCH]', id, 'resolved');
      return id;
    }
    console.log('[CEE SEARCH] no confident match', titles.join(' / '), meta.year || '');
    return null;
  });
}
function numberOf(value) {
  const match = String(value == null ? '' : value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function resolveEpisode(seriesId, season, episode, signal, deadline) {
  if (season == null || episode == null) return Promise.resolve(null);
  return cached('episodes-' + seriesId, function () {
    return api('videoSeason/id/' + encodeURIComponent(seriesId), { signal: signal, deadline: deadline }).then(listFrom);
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

function getVideoFiles(videoId, signal, deadline) {
  return cached('player-' + videoId, function () {
    return api('transcoddedFiles/id/' + encodeURIComponent(videoId), { signal: signal, deadline: deadline }).then(listFrom).then(function (files) {
      if (files.length) return files;
      console.log('[CEE PLAYER] primary endpoint empty; trying alternate spelling');
      return api('transcodedFiles/id/' + encodeURIComponent(videoId), { signal: signal, deadline: deadline }).then(listFrom);
    }).catch(function (firstError) {
      console.log('[CEE PLAYER] primary endpoint failed; trying alternate spelling:', firstError.message);
      return api('transcodedFiles/id/' + encodeURIComponent(videoId), { signal: signal, deadline: deadline }).then(listFrom);
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
      quality: quality,
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

function fetchCeeStreams(type, id, season, episode, suppliedMeta, signal, deadline) {
  const startedAt = Date.now();
  const kind = mediaKind(type);
  const parsed = parseInputId(id);
  const targetSeason = parsed.season != null ? parsed.season : season;
  const targetEpisode = parsed.episode != null ? parsed.episode : (parsed.absoluteEpisode != null ? parsed.absoluteEpisode : episode);
  console.log('[CEE TIMING] start', kind, id);

  ensureBudget(deadline, 'metadata resolution');
  return resolveMetadata(parsed, kind, suppliedMeta, signal, deadline).then(function (meta) {
    console.log('[CEE TIMING] metadata', Date.now() - startedAt, 'ms');
    if (meta.directNb) return { meta: meta, baseId: meta.directNb };
    return searchCee(meta, kind, signal, deadline).then(function (baseId) {
      console.log('[CEE TIMING] search', Date.now() - startedAt, 'ms');
      return { meta: meta, baseId: baseId };
    });
  }).then(function (resolved) {
    if (!resolved.baseId) {
      console.log('[CEE TIMING] no-match', Date.now() - startedAt, 'ms');
      return [];
    }
    const videoIdPromise = kind === 'tv'
      ? resolveEpisode(resolved.baseId, targetSeason, targetEpisode, signal, deadline)
      : Promise.resolve(resolved.baseId);
    return videoIdPromise.then(function (videoId) {
      console.log('[CEE TIMING] episode', Date.now() - startedAt, 'ms');
      if (!videoId) return [];
      return getVideoFiles(videoId, signal, deadline).then(function (files) {
        const streams = (!files || !files.length)
          ? []
          : buildStreams(files, null, videoId, kind, targetSeason, targetEpisode);
        console.log('[CEE TIMING] total', Date.now() - startedAt, 'ms', 'streams:', streams.length);
        return streams;
      });
    });
  }).catch(function (error) {
    const message = String(error && error.message || error);
    console.error('[CEE STREAM ERROR]', kind, id, message);
    if (/fetch failed|networkerror|enotfound|econnrefused|etimedout|network request failed/i.test(message)) {
      return diagnoseNetwork().then(function () { throw error; });
    }
    throw error;
  });
}

// CEE-specific adapter: the provider engine owns orchestration; this adapter
// owns only the CEE lookup and stream extraction path.
function createCeeProvider(resolveStreams) {
  if (typeof resolveStreams !== 'function') throw new TypeError('resolveStreams must be a function');
  return {
    id: 'cee',
    name: 'CEE',
    priority: 100,
    skipTimeoutTimer: true,
    getStreams: function (context) {
      return resolveStreams(context.mediaType, context.id, context.season, context.episode,
        context.suppliedMeta, context.signal, context.deadline);
    }
  };
}
const ceeProvider = createCeeProvider(fetchCeeStreams);
const ceeEngine = createProviderEngine({
  providers: [ceeProvider],
  providerTimeoutMs: 25000,
  failureThreshold: 2,
  cooldownMs: 30000
});

function getStreams(input, mediaType, season, episode) {
  const args = input && typeof input === 'object'
    ? input
    : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };
  const id = args.tmdbId != null ? args.tmdbId : (args.id != null ? args.id : args.imdbId);
  const parsed = parseInputId(id);
  const suppliedMeta = metadataFromInput(args, parsed);
  return ceeEngine.getStreams({
    mediaType: args.mediaType || args.type || 'movie',
    id: id,
    season: args.season,
    episode: args.episode,
    suppliedMeta: suppliedMeta
  }).then(function (result) {
    return result.streams;
  });
}

function getEngineHealth() {
  return ceeEngine.getHealth();
}

module.exports = { getStreams: getStreams, getEngineHealth: getEngineHealth };
