# CEE Nuvio

An independently implemented Nuvio provider for **CEE (🇮🇶)**.

## Provider details

- Provider ID: `cee`
- Version: `3.1.2`
- Author: `HashimFaisal`
- Supported media: movies and TV series
- CEE API: `https://cee.buzz/api/android`
- Entry point: `index.js`

## Implementation

The provider now uses a CinemaBox2-style provider architecture (adapter contract, bounded execution, stream validation, adaptive health/circuit breaker, deterministic quality ordering) while keeping CEE as its only upstream source:

- Bounded in-memory LRU caching with in-flight request coalescing for metadata, title searches, episode lists, and player responses.
- CinemaBox-style ordered title search: primary title first, stop immediately on a confident match, then run year-qualified and alternate-title fallbacks concurrently; return immediately on an exact external-ID fallback instead of waiting for slower aliases; inspect page 2 only when page 1 is full and inconclusive.
- A bounded provider deadline, per-request fetch timeout with AbortController cancellation, one bounded retry for transient GET/network failures, and exponential circuit-breaker cooldowns.
- Arabic-aware title normalization and confidence-based matching.
- IMDb metadata through Cinemeta; TMDB numeric IDs use the Nuvio runtime's `TMDB_API_KEY`.
- MAL metadata lookup through AniList.
- Strict season-and-episode matching with explicit fields and common SxxExx / 2x03 / Episode 3 labels. Ambiguous matches still fail closed.
- CEE's established `transcoddedFiles` player route is tried first, with `transcodedFiles` as a fallback.
- The manifest follows Cinemana's field structure and declares Android support.
- Strict HTTP URL validation, rejection diagnostics, duplicate removal, normalized quality metadata and quality-first sorting with provider priority, productive rate and latency tie-breakers. Returned stream objects expose `name`, `title`, `url`, and `quality`, with `behaviorHints.proxyHeaders` only when supplied by CEE.
- Explicit `requestHeaders` and `responseHeaders` supplied by CEE's player response are forwarded through Nuvio's `behaviorHints.proxyHeaders`; no headers are fabricated when CEE does not return them.
- Network diagnosis only after a network-level failure.

## Ownership and implementation

The active provider implementation in `index.js` is written independently for this repository and maintained as **HashimFaisal**'s CEE Nuvio project. No copied provider source is included in the active project files.

## Install manifest

`https://raw.githubusercontent.com/HashimFaisal/CEE-Nuvio/main/manifest.json`

## Compatibility notes

The provider uses the Nuvio JavaScript runtime's `fetch`, `Promise`, `Map`, and `Set` support. Request cancellation is opportunistic when `AbortController` is available; the provider still handles runtimes where it is unavailable. The provider deadline uses the runtime's timer support.

## Offline regression tests

Run with Node.js:

```bash
node tests/provider.test.js
```

The offline tests cover movie and episode resolution, quality ordering, duplicate URL removal, explicit playback-header forwarding, primary-query early stop, ordered fallback search, metadata fast paths, and rejection of ambiguous episode matches, plus early return on exact external-ID fallbacks.

Live source availability, platform compatibility, and playback still require verification inside Nuvio on the target network. Header forwarding is conditional on CEE returning those explicit fields; it does not prove that CEE requires them or that it will increase throughput.


### 3.1.2 — Nuvio timer-safe HTTP lifecycle

- Match CinemaBox's embedded-runtime request pattern: no per-request timeout timers or `Promise.race` wrappers around successful HTTP calls.
- Keep deadline checks before requests and after response-body reads, with bounded retries for transient GET failures.
- Add a regression test asserting the successful playback path schedules no per-request timeout handles.
