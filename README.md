# CEE Nuvio

An independently implemented Nuvio provider for **CEE (🇮🇶)**.

## Provider details

- Provider ID: `cee`
- Version: `2.0.2`
- Author: `HashimFaisal`
- Supported media: movies and TV series
- CEE API: `https://cee.buzz/api/android`
- Entry point: `index.js`

## Implementation

The provider follows the request and resolution flow used by the standalone Cinemana plugin, while remaining connected only to CEE:

- Promise-based in-memory caching for metadata, searches, episode lists, details, and player responses.
- Arabic-aware title normalization and confidence-based matching.
- IMDb metadata through Cinemeta; TMDB numeric IDs use the Nuvio runtime's `TMDB_API_KEY`.
- MAL metadata lookup through AniList.
- Strict season-and-episode matching. If there is not exactly one match, no stream is returned.
- CEE's established `transcoddedFiles` player route is tried first, with `transcodedFiles` as a fallback.
- The manifest follows Cinemana's field structure and declares Android support.
- Stream URL normalization, duplicate removal, and quality sorting. Returned stream objects keep the same base fields as Cinemana: `name`, `title`, and `url`.
- Explicit `requestHeaders` and `responseHeaders` supplied by CEE's player response are forwarded through Nuvio's `behaviorHints.proxyHeaders`; no headers are fabricated when CEE does not return them.
- Network diagnosis only after a network-level failure.

## Ownership and implementation

The active provider implementation in `index.js` is written independently for this repository and maintained as **HashimFaisal**'s CEE Nuvio project. No copied provider source is included in the active project files.

## Install manifest

`https://raw.githubusercontent.com/HashimFaisal/CEE-Nuvio/main/manifest.json`

## Compatibility notes

The provider uses the Nuvio JavaScript runtime's `fetch`, `Promise`, `Map`, and `Set` support. It intentionally does not depend on `AbortController` or native timers, because the extracted CEE runtime notes identify QuickJS targets without those APIs.

## Offline regression tests

Run with Node.js:

```bash
node tests/provider.test.js
```

The offline tests cover movie source resolution, quality ordering, duplicate URL removal, the Cinemana-compatible stream object shape, exact episode resolution, and rejection of ambiguous episode matches.

Live source availability, platform compatibility, and playback still require verification inside Nuvio on the target network. Header forwarding is conditional on CEE returning those explicit fields; it does not prove that CEE requires them or that it will increase throughput.
