# CEE Nuvio

An independently implemented Nuvio provider for **CEE (🇮🇶)**.

## Provider details

- Provider ID: `cee`
- Version: `2.0.5`
- Author: `HashimFaisal`
- Supported media: movies and TV series
- CEE API: `https://cee.buzz/api/android`
- Entry point: `index.js`

## Implementation

The provider follows the request and resolution flow used by the standalone Cinemana plugin, while remaining connected only to CEE:

- Bounded in-memory LRU caching with in-flight request coalescing for metadata, title searches, episode lists, and player responses.
- CinemaBox-style ordered title search: primary title first, stop immediately on a confident first-page match, then run year-qualified and alternate-title fallbacks concurrently only when needed.
- Abort-aware request flow and a bounded provider deadline so a slow alias lookup cannot hold the source test open indefinitely.
- Arabic-aware title normalization and confidence-based matching.
- IMDb metadata through Cinemeta; TMDB numeric IDs use the Nuvio runtime's `TMDB_API_KEY`.
- MAL metadata lookup through AniList.
- Strict season-and-episode matching. If there is not exactly one match, no stream is returned.
- CEE's established `transcoddedFiles` player route is tried first, with `transcodedFiles` as a fallback.
- The manifest follows Cinemana's field structure and declares Android support.
- Stream URL validation, duplicate removal, CinemaBox-style quality metadata and quality sorting. Returned stream objects expose `name`, `title`, `url`, and `quality`, with `behaviorHints.proxyHeaders` only when supplied by CEE.
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

The offline tests cover movie and episode resolution, quality ordering, duplicate URL removal, explicit playback-header forwarding, primary-query early stop, ordered fallback search, metadata fast paths, and rejection of ambiguous episode matches.

Live source availability, platform compatibility, and playback still require verification inside Nuvio on the target network. Header forwarding is conditional on CEE returning those explicit fields; it does not prove that CEE requires them or that it will increase throughput.
