<p align="center">
  <img src="apps/splash-worker/public/assets/jooevents-wordmark.png" width="384" height="68" alt="JooEvents">
</p>

# JooEvents

## Manage as little as possible.

JooEvents is event management for people who would prefer not to spend their days
managing an event. It is being built to handle the work between putting up a Call for
Speakers and putting the programme on your website: submissions, review, decisions,
speaker tasks, scheduling, communications, and publishing.

Proposals arrive, get sorted and scored. Speakers get chased for their headshots. The
schedule gets built and the programme lands on your website. Your part is the yes, the
no, and a look before anything leaves.

[See how it works](https://jooevents.com) ·
[Open the browser demo](https://jooevents-demo.joocorp.com/app)

## What is in the repository

- The organizer, reviewer, participant, and public event surfaces.
- The application operations, persistence contracts, migrations, and tests needed to
  build and verify the released app.
- A secured MCP surface through which authorized agents use the same permission-checked
  operations as people do.

Agent-proposed consequential changes remain proposals until a person reviews and
commits them. Ordinary controls remain available; using an agent is a choice, not an
entrance fee.

## Production direction

JooEvents is being completed first as a single-machine Bun and SQLite application. The
production shape puts the web interface, HTTP API, authentication, application
operations, database, files, and background work in one service on one origin.
Cloudflare remains a later production target through the same application boundaries;
it is not required for the first production release.

### Where the SQLite path stands

The single-machine path is substantially implemented. The repository already contains:

- a production-mode Bun server that serves the built application and reserved backend
  routes on one origin;
- a retained SQLite migration ledger with schema validation, process ownership, and
  startup refusal when the database is not safe to open;
- Google authentication, bootstrap-owner creation, admission, sessions, and current
  access checks over retained SQLite;
- a public-only release builder plus installer, doctor, service definitions, running
  verification, and stopped upgrade commands;
- verified complete-install backup and non-replacing restore-rehearsal commands for
  SQLite, retained files, and redacted configuration; and
- SQLite repositories and reviewed change operations across events, forms,
  submissions, review, decisions, speakers, scheduling, publishing, and communications.

The retained migration chain now contains the complete application schema as well as
identity and admission, with a verified upgrade from the earlier identity/access
database. The configured server mounts the joined event workflow over the retained
database and filesystem, starts supervised background work after the listener, and
drains it before storage closes. A frozen retained journey now crosses public
submission, review, decision, speaker confirmation, tasks, scheduling, publication,
participant entry, restart, and idempotent retry.

The remaining line is release closure. The final artifact still needs its clean,
committed-checkout build; supported operating-system service activation and HTTPS
deployment must be verified; and the controlled outbound-email checkpoint plus final
release-byte recovery sweep must close. The
[single-machine operator guide](docs/operator/single-machine.md) now documents the
executable install, doctor, verification, upgrade, backup, and restore-rehearsal path;
it remains a pre-release guide until walked through from the tagged artifact. The
[single-machine preview 1 notes](docs/releases/single-machine-preview-1.md) name the
current compatibility floor, operating limits, and remaining non-claims.

JooEvents is therefore pre-release and **not ready for production event data yet**. It
is close enough that the SQLite production work is the main story here; it is not close
enough to suggest putting an actual attendee list into it.

The Cloudflare production composition—Worker, D1, R2, Queues, Cron, application auth,
and outbound email—comes after the single-machine release. Its adapters and boundaries
are being kept portable, but that composition is not deployable today.

## Build and inspect

The repository uses Bun 1.3.6. From its root:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

For local product development:

```sh
bun run dev
```

The current development UI uses synthetic sample data. It is useful for inspecting the
product while the retained runtime composition is completed; it is not the production
storage path.

## Demo

The hosted browser demo is a disposable product tour. It has no database, email
delivery, shared persistence, or external model calls. Most changes reset when the page
reloads.

[Open the demo](https://jooevents-demo.joocorp.com/app) or deploy a copy to your own
Cloudflare account:

```sh
bun run demo:setup
```

The demo CLI builds and checks the sample, performs a Wrangler dry run, verifies the
Cloudflare account, and asks again before creating or updating a public Worker. Inspect
the complete plan without running it:

```sh
bun run demo:setup -- --provider cloudflare --plan
```

The CLI has no credential field. Wrangler handles authentication in the browser, and
the CLI never asks for a token or password. The provider boundary is ready for later
targets, while the unqualified `setup` command remains reserved for a real production
installer.

Read [Install the browser sample](docs/installation/browser-sample.md) for the guided,
manual, and LLM-assisted demo paths.

## License

Except where noted otherwise, the source code, public documentation, and first-party
artwork in this repository—including Bowlboy—are available under the
[JooEvents Community and Small Organization License](LICENSE).

It permits free personal, community, and qualifying small-organization use, along with
public forks. Larger organizations can begin their own internal use under a
notice-first courtesy period. Selling, white-labelling, hosting, or embedding
substantial JooEvents functionality requires a separate commercial license.

Pricing is intentionally not posted yet. Contact [bowlboy@joocorp.com](mailto:bowlboy@joocorp.com)
and we can work out something reasonable, including royalties where that fits. I am
starting with these terms to keep my options open while the project is young, and I am
still considering Apache License 2.0 later.

The [friendly licensing overview](docs/reference/licensing.md) explains the thresholds,
fork rights, commercial use, and courtesy period. See [NOTICE](NOTICE) for attribution
and the [trademark policy](TRADEMARKS.md) for use of the JooEvents and Bowlboy marks.

## Maintainer

JooEvents is a Bowlboy project, published by JooCorp Private Limited.

Follow [@thebowlboy](https://x.com/thebowlboy) or
[thebowlboy on GitHub](https://github.com/thebowlboy). Security reports are welcome;
see [SECURITY.md](SECURITY.md).
