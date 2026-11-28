'use strict';

const assert = require('assert');
const { createProviderEngine } = require('../engine/provider-engine');
const { createCeeProvider } = require('../providers/cee');

async function main() {
  const provider = createCeeProvider(async function () {
    return [
      { name: 'CEE · 720p', title: '720p • CEE', url: 'https://cdn.example/720.mp4', quality: '720p' },
      { name: 'CEE · 1080p', title: '1080p • CEE', url: 'https://cdn.example/1080.mp4', quality: '1080p',
        behaviorHints: { proxyHeaders: { request: { Referer: 'https://cee.buzz/' } } } },
      { name: 'duplicate', url: 'https://cdn.example/1080.mp4' },
      { name: 'bad scheme', url: 'javascript:alert(1)' }
    ];
  });
  const engine = createProviderEngine({ providers: [provider] });
  const result = await engine.getStreams({ mediaType: 'movie', id: 'tt0133093' });

  assert.deepStrictEqual(result.streams.map(stream => stream.name), ['CEE · 1080p', 'CEE · 720p']);
  assert.deepStrictEqual(result.streams[0].behaviorHints, {
    proxyHeaders: { request: { Referer: 'https://cee.buzz/' } }
  });
  assert.strictEqual(result.streams[0].quality, '1080p', 'normalized streams should retain source quality metadata');
  assert.deepStrictEqual(Object.keys(engine.getHealth().cee).sort(), [
    'attempts', 'circuitOpen', 'cooldownMs', 'emptyResponses', 'errorCount', 'failures',
    'lastStatus', 'latencyEwmaMs', 'productiveRate', 'rejectedStreams', 'retryAt',
    'successRate', 'successes', 'timeoutCount', 'validStreams'
  ]);
  assert.strictEqual(engine.getHealth().cee.successes, 1);

  let calls = 0;
  const failing = createProviderEngine({
    providers: [{ id: 'cee', name: 'CEE', getStreams: async function () {
      calls++;
      throw new Error('upstream unavailable');
    } }],
    failureThreshold: 1,
    cooldownMs: 30000
  });
  await failing.getStreams({});
  const afterFailure = await failing.getStreams({});
  assert.strictEqual(calls, 1, 'open circuit must prevent repeated failing upstream requests');
  assert.strictEqual(afterFailure.providers[0].status, 'circuit-open');
  assert.strictEqual(failing.getHealth().cee.errors, 1);


  let aborted = false;
  const timed = createProviderEngine({
    providers: [{ id: 'slow-cee', name: 'CEE', getStreams: function (context) {
      return new Promise(function (resolve, reject) {
        context.signal.addEventListener('abort', function () {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    } }],
    providerTimeoutMs: 30
  });
  const timedResult = await timed.getStreams({});
  assert.strictEqual(timedResult.providers[0].status, 'timeout', 'slow upstream requests must respect the provider deadline');
  assert.strictEqual(aborted, true, 'provider timeout should abort the in-flight upstream request when supported');
  console.log('CEE provider engine tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
