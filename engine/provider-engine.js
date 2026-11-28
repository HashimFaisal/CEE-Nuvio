'use strict';

const QUALITY = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, '360p': 360, '240p': 240 };

function qualityRank(value) {
  const raw = String(value || '');
  if (/4\s*k/i.test(raw)) return 2160;
  const match = raw.match(/(2160|1440|1080|720|576|480|360|240)/);
  return match ? Number(match[1]) : 0;
  return match ? Number(match[1]) : 0;
}

function validStreamUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s\\]/.test(value)) return false;
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

function createProviderEngine(options) {
  const config = options || {};
  const providers = (config.providers || []).slice();
  const timeoutMs = Math.max(500, Number(config.providerTimeoutMs) || 25000);
  const failureThreshold = Math.max(1, Number(config.failureThreshold) || 2);
  const cooldownMs = Math.max(1000, Number(config.cooldownMs) || 30000);
  const now = config.now || Date.now;
  const health = new Map();

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
    if (state.openUntil > now()) {
      return { providerId: provider.id, status: 'circuit-open', streams: [] };
    }
    const started = now();
    state.attempts++;
    let timer;
    let timedOut = false;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const providerContext = Object.assign({}, context, {
        providerId: provider.id,
        signal: controller ? controller.signal : undefined,
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
      state.latencyEwmaMs = state.latencyEwmaMs == null
        ? elapsedMs : state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
      streams.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
      return { providerId: provider.id, status: state.lastStatus, elapsedMs, streams };
    } catch (error) {
      if (timer) clearTimeout(timer);
      const elapsedMs = Math.max(0, now() - started);
      state.failures++;
      state.errors++;
      if (timedOut) state.timeouts++;
      state.lastStatus = timedOut ? 'timeout' : 'error';
      state.latencyEwmaMs = state.latencyEwmaMs == null
        ? elapsedMs : state.latencyEwmaMs * 0.7 + elapsedMs * 0.3;
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

module.exports = { createProviderEngine, qualityRank, validStreamUrl };
