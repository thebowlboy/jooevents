---
title: Connect an external agent through the JooEvents API
subtitle: A safe first-run path for an organizer and a third-party agent working on their behalf.
variant: trailhead
kicker: External agents
updated: 17 August 2026
---

# Connect an external agent through the JooEvents API

> A third-party agent connects through the API: it can make authorized reads directly and propose exact changes, but every change waits for a person to review and approve it.

JooEvents does not provide an agent-direct product surface or hosted agent. Use this guide for the JooEvents installation the organizer wants an external agent to help with. The installation's own origin is the authority for its API, key standing, available tools, and pending work.

## Give this page to your agent

> Read this API guide, then inspect the installation before asking questions. Run safe HTTP checks yourself. Pause while the owner creates, copies, and stores the API key; never ask for that secret in chat. Resume only after the owner confirms that the key is stored in the agent's local secret configuration.

## Before you start

- You need the installation's HTTPS base URL, for example `https://events.example.org`.
- The owner needs access to **Settings → API keys** in that installation.
- The agent needs an HTTP client and a local secret store or environment-variable mechanism.

## 1. Confirm the installation

The API contract is public and does not need a key:

```sh
curl --fail-with-body https://events.example.org/api/v1/openapi.json
```

A successful response is HTTP 200 with JSON. A 404, HTML page, or connection failure means this is not the expected JooEvents API origin; correct the base URL before continuing.

## 2. Create the key — owner checkpoint

The owner opens **Settings → API keys**, chooses the narrowest key that serves the job, chooses a finite expiry or **Never expires**, and copies the secret when it is shown.

The secret is shown once. Stop here: the agent should not receive it in conversation, a URL, source control, or a command transcript.

## 3. Store the key outside the conversation

The owner stores the secret in the agent's normal secret manager or local environment. The agent needs only the variable name and base URL:

```sh
JOOEVENTS_ORIGIN=https://events.example.org
JOOEVENTS_API_KEY=<stored-by-your-secret-manager>
```

The placeholder above is intentionally not a usable API key. Do not place a real value in shell history or documentation.

## 4. Orient the agent

With the key available locally, begin with the current truth on this installation:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $JOOEVENTS_API_KEY" \
  "$JOOEVENTS_ORIGIN/api/v1/me"

curl --fail-with-body \
  -H "Authorization: Bearer $JOOEVENTS_API_KEY" \
  "$JOOEVENTS_ORIGIN/api/v1/tools"

curl --fail-with-body \
  -H "Authorization: Bearer $JOOEVENTS_API_KEY" \
  "$JOOEVENTS_ORIGIN/api/v1/pending"
```

`/me` reports credential standing and limits. `/tools` is the current read-tool catalog. `/pending` shows the connected agent's non-terminal plans and authorized attention. If the task may need a change, inspect `/api/v1/plan-operations` too. See [how the API works](operating-model.md) for the boundaries each call describes.

## 5. Verify a direct read

Select an **active** tool from `/tools`; do not assume a tool named in prose is available. Its catalog entry supplies the argument schema. Call it with the standard envelope:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $JOOEVENTS_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST "$JOOEVENTS_ORIGIN/api/v1/tools/<active-tool-name>" \
  --data '{"arguments":{}}'
```

Use the catalog schema to replace the empty object where arguments are required. Reads do not use `Idempotency-Key`.

## 6. Verify the plan boundary

Only inspect `/plan-operations` unless the organizer actually wants a change. When they do, submit a small, coherent plan with the required `Idempotency-Key`, then return its review URL to a person. Submitting a plan does not apply its steps; a person must approve it first.

## You are connected when

- `/api/v1/me` returns the expected standing and limits for the locally stored key.
- `/api/v1/tools` provides a current catalog and one active read returns a valid response.
- The agent can explain that a requested change becomes a human-reviewed plan, not a direct write.

## If something refuses

| What you receive | What it means | Safe next step |
| --- | --- | --- |
| Uniform HTTP 401 | The key is missing, malformed, expired, revoked, or otherwise not accepted. | Ask the owner to check or rotate access; do not try to identify which condition applies. |
| HTTP 403 | The key lacks endpoint capability. | Inspect `/me` and ask the owner to review the key's purpose and scope. |
| HTTP 200 structured outcome | A policy, availability, quota, or business condition decided this specific call. | Read the typed outcome and its availability or hint before choosing the next action. |
| HTTP 429 | The request rate is limited. | Honor `Retry-After`, then resume at a slower pace. |

Record the response's correlation ID when asking for help. It is safe to share; never include the key or unnecessary workspace content.

## Remove or rotate access

Only the key's owner manages it in **Settings → API keys**. Rotation creates a successor so the secret store can be updated before the old key stops working; revocation stops access. After either action, restart at `/api/v1/me` with the configured replacement.
