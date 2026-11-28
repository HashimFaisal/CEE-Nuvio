# CEE Engine

CEE follows the same architecture pattern as CinemaBox2:

`Nuvio → bundled index.js → provider engine → CEE adapter → CEE API → normalized streams → Nuvio`

## Source layout

- `engine/provider-engine.js`: provider orchestration, timeout handling, circuit breaker, health counters, URL validation, stream normalization, de-duplication and quality ordering.
- `providers/cee.js`: the CEE-specific adapter. It owns no generic orchestration logic.
- `index.js`: the single bundled entry point loaded by Nuvio. It contains the runtime bundle so the add-on does not depend on Nuvio resolving local CommonJS files.

## Runtime design

CEE remains an independent upstream. The engine does not add CinemaBox, Cinemana, or unrelated providers. CEE search, metadata, episode resolution and player-file endpoints remain in the CEE adapter path. The orchestration layer handles provider deadlines, failures, cooldown, normalized output and health.

## Validation

Run `node tests/provider.test.js` and `node tests/provider-engine.test.js`.
