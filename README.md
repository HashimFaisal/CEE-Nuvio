# CEE-Nuvio

Standalone extraction of the **CEE (🇮🇶)** provider from [SafaaSalam/Arabic-Nuvio](https://github.com/SafaaSalam/Arabic-Nuvio).

## Provider
- Provider ID: `cee`
- Original provider version: `1.2.0`
- Supported types: movies and TV series
- Main site/API: `https://cee.buzz` / `https://cee.buzz/api/android`
- Features: quality selection, episode lookup, and subtitle metadata.

## Files
- `manifest.json` — standalone manifest containing only CEE.
- `providers/cee.js` — original provider implementation, kept unchanged.

## Attribution
The provider implementation is by **SafaaSalam**. This repository isolates that provider; it does not include other providers from Arabic-Nuvio.

## Nuvio manifest
`https://raw.githubusercontent.com/HashimFaisal/CEE-Nuvio/main/manifest.json`

This is a code extraction. Live stream availability and compatibility must still be tested inside Nuvio on the target network.
