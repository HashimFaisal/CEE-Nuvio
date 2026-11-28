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
  const providerById = new Map();

  providers.forEach(provider => {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(provider.id || '')) ||
        typeof provider.getStreams !== 'function') throw new TypeError('Invalid provider contract');
    providerById.set(provider.id, provider);
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
      streams.push(Object.assign({}, stream, { _providerId: result.providerId }));
    }));
    streams.sort((a, b) => {
      const qualityDifference = qualityRank(b.quality) - qualityRank(a.quality);
      if (qualityDifference) return qualityDifference;
      const providerA = providerById.get(a._providerId);
      const providerB = providerById.get(b._providerId);
      const priorityDifference = Number(providerB && providerB.priority || 0) - Number(providerA && providerA.priority || 0);
      if (priorityDifference) return priorityDifference;
      const healthA = health.get(a._providerId);
      const healthB = health.get(b._providerId);
      const productiveA = healthA && healthA.attempts ? healthA.successes / healthA.attempts : 0;
      const productiveB = healthB && healthB.attempts ? healthB.successes / healthB.attempts : 0;
      if (productiveB !== productiveA) return productiveB - productiveA;
      const latencyA = healthA && healthA.latencyEwmaMs != null ? healthA.latencyEwmaMs : Infinity;
      const latencyB = healthB && healthB.latencyEwmaMs != null ? healthB.latencyEwmaMs : Infinity;
      return latencyA - latencyB;
    });
    streams.forEach(stream => { delete stream._providerId; });
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

module.exports = { createProviderEngine, normalizeStream, normalizeQuality, qualityRank, validStreamUrl, streamRejectionReason };
