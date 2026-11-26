# CEE Nuvio

An independently implemented Nuvio provider for **CEE (🇮🇶)**.

## Provider details

- Provider ID: `cee`
- Version: `2.0.0`
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
- Stream URL normalization, duplicate removal, quality sorting, and subtitle metadata.
- Network diagnosis only after a network-level failure.

## Attribution

The earlier extracted implementation remains in `providers/cee.js` as an attributed reference copy from [SafaaSalam/Arabic-Nuvio](https://github.com/SafaaSalam/Arabic-Nuvio). It is **not** the active implementation in this version. The active `index.js` is a separate implementation and does not copy the original provider source or Cinemana source code.

## Install manifest

`https://raw.githubusercontent.com/HashimFaisal/CEE-Nuvio/rebuild/cinemana-architecture/manifest.json`

## Compatibility notes

The provider uses the Nuvio JavaScript runtime's `fetch`, `Promise`, `Map`, and `Set` support. It intentionally does not depend on `AbortController` or native timers, because the extracted CEE runtime notes identify QuickJS targets without those APIs.

## Offline regression tests

Run with Node.js:

```bash
node tests/provider.test.js
```

The offline tests cover movie source resolution, quality ordering, duplicate URL removal, subtitle metadata, exact episode resolution, and rejection of ambiguous episode matches.

Live source availability, platform compatibility, and playback still require verification inside Nuvio on the target network. Offline tests and syntax validation do not establish live playback.
