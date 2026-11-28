'use strict';

const assert = require('assert');
const { createProviderEngine } = require('../engine/provider-engine');
const { createCeeProvider } = require('../providers/cee');

async function main() {
  const provider = createCeeProvider(async function () {
    return [
      { name: 'CEE · 720p', title: '720p • CEE', url: 'https://cdn.example/720.mp4' },
      { name: 'CEE · 1080p', title: '1080p • CEE', url: 'https://cdn.example/1080.mp4',
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
  assert.deepStrictEqual(Object.keys(engine.getHealth().cee).sort(), [
    'attempts', 'circuitOpen', 'empty', 'errors', 'failures', 'lastStatus',
    'latencyEwmaMs', 'retryAt', 'successes', 'timeouts'
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

  console.log('CEE provider engine tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
