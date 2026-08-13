# Deploy the sample demo to Cloudflare

This guide deploys the current browser-only JooEvents sample to a Cloudflare Worker.
It is intended for evaluators and maintainers who want a product tour before the
production adapters are ready.

The result has:

- `jooevents-demo.joocorp.com`, the custom domain declared in the checked-in configuration;
- a reversible Cloudflare Access email one-time-PIN gate (the hosted JooEvents demo is
  currently public through an explicit Bypass/Everyone policy);
- direct entry into `/app`, without JooEvents login;
- no database, email delivery, object storage, queue, or external model calls; and
- no `workers.dev` hostname that could bypass the Access application.

This is not suitable for real event or personal data. The sample data ships in the
browser bundle. Most edits live only in the current browser tab's in-memory workspace
and reset on a full reload. The selected sample scenario and events created through
the sample flow may remain in that browser's cookies or local storage. Nothing is
shared with another browser.

## The agent-assisted path

After cloning the repository, an operator can tell a coding agent:

> Read `docs/operator/cloudflare-demo.md` and guide me through deploying the demo. Inspect
> each checkpoint before asking me to do anything. Run safe repository commands for
> me, but pause for browser login and Zero Trust policy changes. Never ask me to paste
> a credential or login code into chat.

The agent should work one checkpoint at a time and resume from the last verified
checkpoint. Commands in this guide run from the repository root.

## 1. Install and verify

Install the pinned toolchain dependencies:

```sh
bun install --frozen-lockfile
```

Confirm the demo Worker and web bundle compile locally:

```sh
bun run --cwd apps/demo-worker check
bun test apps/demo-worker
bun run demo:build:cloudflare
bunx wrangler deploy --config wrangler.demo.jsonc --dry-run
```

The dry run should list only `ASSETS`. The demo must not acquire D1, R2, Queue,
Email, or application-secret bindings.

## 2. Log in to Cloudflare

Check whether Wrangler is already authenticated:

```sh
bun run cloudflare:whoami
```

If it is not, run this in an interactive terminal and complete the browser flow:

```sh
bunx wrangler login
```

Run `bun run cloudflare:whoami` again and confirm it names the intended Cloudflare
account. Do not paste an API token or the browser callback into an agent conversation.
Wrangler's interactive OAuth flow keeps the credential in its local credential store.

## 3. Configure the reversible Cloudflare Access gate

For a private deployment, in Cloudflare Zero Trust create a self-hosted Access application for
`jooevents-demo.joocorp.com`. Add an Allow policy using the One-time PIN login method
and the email scope appropriate for the intended evaluators. Save the policy before
leaving the application.

Configure One-time PIN as an Access login method if it is not already available for
the account. The resulting sign-in page asks for an email address and sends a
short-lived login code; there is no shared application password and no login code in
this repository.

Set the application's session duration deliberately. Access authentication logs may
contain evaluator email addresses and network metadata, so disclose that collection,
limit access to people who need it, and apply the retention policy appropriate to the
organization.

## 4. Deploy and verify

Deploy the checked-in build and Worker configuration:

```sh
bun run demo:deploy:cloudflare
```

Wrangler prints the final HTTPS URL. Open it in a private browser window and verify:

1. in private mode, an anonymous visit redirects to the Cloudflare Access email-code
   page and completing the one-time-PIN flow opens the site; in public mode, an
   anonymous visit reaches the app directly;
2. `/` redirects to `/app` instead of showing the simulated JooEvents sign-in page;
3. a clean browser opens the **Decision crunch** sample scenario;
4. moving a schedule item remains visible after navigating to another in-app page;
5. a full reload resets that in-memory schedule edit; and
6. the Worker has no active `workers.dev` hostname that bypasses Access.

Future code updates use the same deploy command. The Access application and policy
remain Cloudflare-managed configuration, independent of the application bundle.

## Opening the demo later

Cloudflare Access is the only optional authentication layer for this demo. To open the
demo publicly without deleting its private policy, add an Access policy with:

- Action: `Bypass`
- Include: `Everyone`
- no Require or Exclude rules

Verify that an anonymous request reaches `/app` without a login redirect. Bypass
disables Access authentication controls and Access request logging for matching
traffic. The checked-in Worker continues to apply private/no-store, anti-framing, and
no-index headers.

To make the demo private again, disable or delete only the public Bypass policy. Keep
the existing One-time PIN Allow policy so the email-code gate resumes immediately.
Verify the relock in a private browser window before announcing the change.

Cloudflare automatically scales Workers across its network and applies its platform
DDoS protection. A paid Workers plan removes the free plan's daily request ceiling,
but it does not make execution unlimited; the demo config therefore also caps Worker
CPU time. Because every protected asset passes through the Worker, these are
billed Worker requests rather than free direct static-asset requests.

Before announcing public mode, attach a proxied custom demo hostname in a
Cloudflare-managed zone and configure the zone-level controls appropriate to the
audience:

- enable Bot Fight Mode (or the plan's more configurable bot product);
- enable the applicable WAF Managed Rules;
- add a conservative rate-limiting rule with a Managed Challenge for abusive traffic;
  and
- verify legitimate browsers, accessibility tools, and monitoring are not challenged
  unexpectedly.

Those controls are configured at Cloudflare's edge. The sample app should not grow a
CAPTCHA or Turnstile flow merely to make the demo public. Turnstile remains an option
later for truly public write surfaces such as an application form if abuse evidence
shows it is needed.

## Local Worker preview

Run:

```sh
bun run demo:dev:cloudflare
```

Access protects the deployed hostname at Cloudflare's edge, so the local preview has
no login gate. Do not expose it to an untrusted network. The ordinary `bun run dev`
path also remains available.

## What production will add

The production Cloudflare deployment is intentionally separate from this demo. Its
planned shape is a Worker serving the web app and Hono API, with D1 for relational
state, R2 for files, Queues and Cron Triggers for background work, application auth,
and an outbound-email adapter. Cloudflare Email Sending is currently a public-beta,
paid-plan option, so JooEvents keeps email behind a replaceable provider interface.

Those runtime adapters and the production migration/deployment gate are not complete.
Do not add production bindings to `wrangler.demo.jsonc`, and do not use this demo with
real event data. A supported production guide will replace this note when the
application can verify migrations, auth callbacks, email readiness, backups, and
restore behavior end to end.

Cloudflare references:

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare bot protection](https://developers.cloudflare.com/bots/)
- [WAF rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
