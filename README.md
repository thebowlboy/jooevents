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

## Deployment

JooEvents ships as one self-contained service: a single Bun process serves the web
interface and API on one origin and owns its SQLite database, uploaded files, and
supervised background work. Running it means one machine, one service, and one data
directory to back up; put your own HTTPS — any reverse proxy or tunnel — in front.
The [single-machine operator guide](docs/operator/single-machine.md) documents the
executable install, doctor, verify, upgrade, backup, and restore path.

The application core sits behind provider-neutral persistence, file, job, and mail
boundaries, so alternative databases and storage providers are adapter work rather
than rewrites. The one hard requirement is a persistent filesystem for the database
and file root; serverless hosts with ephemeral disks cannot run it.

JooEvents is pre-release and **not ready for production event data yet**. The
[preview release notes](docs/releases/single-machine-preview-1.md) name the current
compatibility floor, operating limits, and remaining non-claims.

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

The development UI runs on synthetic sample data so the product can be inspected
without a real database. It is not the production storage path.

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
