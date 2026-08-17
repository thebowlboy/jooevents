# Single-machine preview 1

This is the first distributable preview of the Bun, SQLite, and local-files JooEvents
installation. It is **not a production-data release**. Use synthetic or disposable
event data until a later release note explicitly removes that restriction.

## Included

- One-origin Bun service for the organizer, reviewer, participant, and published event
  surfaces, reserved backend routes, Google authentication, and current access checks.
- Retained SQLite application data, retained filesystem uploads, and supervised
  background delivery, cleanup, and approved-action work.
- Owner bootstrap, event setup, public submissions, review, decisions, speaker
  confirmation, tasks, scheduling, publishing, participant entry, and operation
  history across service restarts.
- Public release builder, installer, doctor, systemd and launchd definitions, running
  verification, stopped upgrades, complete-install backups, backup verification, and
  isolated restore rehearsal.

## Compatibility

- Release series: `single-machine-preview-1`.
- SQLite compatibility floor: `sqlite-e2-s8`, migration runner version 2, terminal
  migration sequence 8. This floor identifier is a database compatibility contract,
  not a product semantic version.
- Runtime: Bun 1.3.6 or newer on Linux or macOS, x64 or arm64. Release bundles are
  platform- and architecture-specific.
- Storage: one local SQLite database and one local retained-file root, owned by one
  JooEvents process. Network filesystems and multiple writers are unsupported.

An existing retained development database must first reach the supported migration
chain and be explicitly promoted. The operator commands refuse unknown, partial,
changed, actively owned, or incompatible databases rather than guessing an upgrade.

## Operating limits

- The SQLite service runs one backend storage request at a time, with at most 128
  queued requests and a 30-second queue wait. Saturation returns retryable
  `503 service_busy` with `Retry-After: 1`.
- Default file limits are 100 MiB per participant upload, 250 MiB per organizer
  upload, and 1 GiB per participant per event. The HTTPS proxy request-body ceiling
  must cover the larger configured per-file limit.
- The Bun listener defaults to `127.0.0.1`; terminate HTTPS at a reverse proxy. An
  explicit `0.0.0.0` override is for controlled preview or container networking only.
- There is no high-availability or horizontal-write mode in this release series.

## Installation and recovery

Follow [Operate JooEvents on one machine](../operator/single-machine.md). Build from a
clean checkout for any distributable artifact. `--allow-dirty` and
`--allow-rehearsal` are explicit preview-only escape hatches and do not produce a
release artifact.

Backups are stopped complete-install snapshots: SQLite, retained blobs, non-secret
configuration, and secret *names*. Secret values remain separate. Restore rehearsal
always creates a new root and never replaces a live installation implicitly.

## Known limits before production data

- A clean tagged artifact still needs its final install, native service activation,
  upgrade, backup, restored-copy, and HTTPS walkthrough.
- Outbound email remains installation-specific and must pass provider readiness plus a
  controlled delivery/receipt check before email-dependent workflows are enabled.
- The Cloudflare Worker/D1/R2/Queues/Cron application composition is not included or
  deployable as the production application in this preview.

The hosted browser demo remains a disposable product tour. Its behavior is not a
storage, authentication, delivery, or recovery guarantee for this installation.
