# Contributing

## Status

This is published as a working reference. It is not actively maintained.
Issues and pull requests are welcome, but expect a best-effort response.

If you want to run it, fork it. That is the intended use.

## Running the checks

```bash
npm ci
npm run lint      # ESLint over src, test, scripts, outage-gate
npm test          # ~1,250 tests. No network and no Cloudflare account needed.
npm run check     # wrangler dry run, validates the configuration
```

All three must pass. The test suite runs offline against Miniflare, so a
change that needs a live account to verify is a change that needs a different
design.

## House style

The existing code and documentation follow a few conventions worth matching:

- Comments explain **why**, and cite the measurement or incident that forced
  the decision. Several constants in `src/` would look arbitrary without the
  paragraph above them; those paragraphs are the point.
- Tests assert contracts, not implementations. Where behaviour depends on a
  vendor detail, there is a contract test that fails loudly when the vendor
  moves. Keep that pattern.
- Prefer failing closed. A guard that cannot prove a sandbox is safe to
  destroy should retry, not assume.

## Before you open a pull request

State what you measured. This repository's history is largely a record of
confident diagnoses that turned out to be wrong until someone produced a
number, and the documents in the engineering record are those numbers.
