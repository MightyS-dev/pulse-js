# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [0.9.1] - 2026-11-15

### Changed

- Without a `debug` option, signals from development builds are now marked as test data: in Node when `NODE_ENV` is `development` or `test`, in the browser when your bundler sets `process.env.NODE_ENV` to one of those. Everything else counts as real data. An explicit `debug` value always wins.

### Added

- README: a Test mode section that explains how signals are marked as test or real.

## [0.9.0] - 2026-11-15

Initial public release.

### Added

- `Pulse.init`, `Pulse.track`, `Pulse.setUser`, `Pulse.flush` and `Pulse.optOut` for sending named signals with an optional number and properties.
- Web build (localStorage queue) and Node build (atomic file queue), ESM and CommonJS, with TypeScript declarations. No runtime dependencies.
- Privacy by construction: no cookies, no advertising or device identifier, no fingerprinting. Sessions use random ids that rotate after 30 minutes of inactivity.
- Optional user id, hashed with SHA-256 on the device; the raw id is never stored or sent.
- One-call opt-out that is remembered and clears the queue.
- Batched delivery: first batch at once, then every 20 seconds by default or by batch size, gzipped request bodies, retries with backoff, and an offline queue that survives restarts.
- Public calls never throw into the host app and never block the main thread.
- Default ingest host `https://in.mightys.dev`, configurable with the `host` option.
