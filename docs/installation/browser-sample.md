# Install the browser sample

This installs the current JooEvents sample locally or deploys it to Cloudflare. The
sample contains synthetic event data and browser-local state. It is a product tour,
not a production JooEvents installation.

Most edits reset on a full reload. Browsers do not share state. Do not use real event
or personal data.

## Guided Cloudflare setup

You need [Bun 1.3.6](https://bun.sh/) and an interactive terminal. From the repository
root, run:

```sh
bun run demo:setup
```

The setup CLI:

1. installs the locked dependencies;
2. type-checks and tests the demo Worker;
3. builds the browser sample and checks the release bundle;
4. compiles the Worker with Wrangler without deploying it;
5. checks which Cloudflare account Wrangler can see;
6. opens Wrangler's browser login when authentication is needed; and
7. asks for confirmation before deploying to a public `workers.dev` address.

No credential value is requested or processed by JooEvents. Wrangler owns its OAuth
flow and local credential storage.

Print the exact commands without running them:

```sh
bun run demo:setup -- --provider cloudflare --plan
```

Cloudflare is the only implemented provider today. The CLI discovers providers through
a common contract, so later providers can supply their own checks, authentication, and
deployment command without changing the guided flow.

## LLM-assisted setup

If you prefer a conversational guide, give a coding agent this instruction:

> Read `docs/installation/browser-sample.md` and guide me through it one checkpoint at
> a time. Inspect before asking me to do anything. Run safe local checks for me, but
> pause before browser authentication or deployment. Never ask me to paste a token,
> password, login callback, or secret into chat.

The agent can run `bun run demo:setup -- --provider cloudflare --plan`, perform the local
checks, and tell you when a human-only step has arrived. Convenience does not require
putting a Cloudflare credential into a model transcript.

## Manual Cloudflare setup

The CLI is a short wrapper around these commands:

```sh
bun install --frozen-lockfile
bun run --cwd apps/demo-worker check
bun test apps/demo-worker
bun run demo:build:cloudflare
bunx wrangler deploy --config wrangler.demo.community.jsonc --dry-run
bunx wrangler whoami
```

If Wrangler is not authenticated, run `bunx wrangler login` and complete the browser
flow. Verify the account with `bunx wrangler whoami`, then deploy:

```sh
bunx wrangler deploy --config wrangler.demo.community.jsonc
```

Wrangler prints the final HTTPS address. Open it in a private browser window, confirm
that `/` leads to `/app`, move a schedule item, navigate to another page, and then
reload. The move should survive in-app navigation and reset on the reload.

The community configuration publishes a public Worker. If the sample should be private,
place it behind a Cloudflare Access self-hosted application before sharing it. The
[official-demo operator guide](../operator/cloudflare-demo.md) covers the custom-domain
and Access-gated variant maintained by the project.

## Local setup

To keep everything on your computer:

```sh
bun install --frozen-lockfile
bun run dev
```

Open the local address printed by Vite. Local development has no Cloudflare Access gate;
do not expose it to an untrusted network.

## What this does not install

There is no supported production installation yet. This command also does not install
the substantially implemented single-machine Bun/SQLite runtime. That separate path
now has the joined event workflow, retained database and files, authentication,
background work, packaging, upgrade, and complete-install recovery mechanisms; its
final release and operator verification gates remain open.

The sample path does not configure D1, R2, Queues, Cron, application login, outbound
email, backups, restore, or shared event state. Production instructions will be
published only after the selected runtime can be deployed and verified end to end.
