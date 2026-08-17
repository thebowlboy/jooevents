---
title: External API recipes
subtitle: Short, discovery-first call sequences for third-party agents connected through the JooEvents API.
variant: console
kicker: External agents
updated: 17 August 2026
---

# External API recipes

> Start with the live API contract and catalog. These recipes are for third-party agents, not a JooEvents-hosted agent surface.

## Recipe format

Each recipe names the question, the discovery call, the action, what proves the result, and the safe branch when the installation refuses. Use the installation's own API origin in every path below.

## Start or resume a session

1. **Discover** — `GET /api/v1/me`.
2. **Call** — `GET /api/v1/pending`.
3. **Verify** — Refresh `/tools` and `/plan-operations` before a new task, especially after key standing or registry information changes.
4. **If refused** — A uniform 401 means owner recovery, not credential diagnosis.

## Find and call a read tool

1. **Discover** — `GET /api/v1/tools`.
2. **Choose** — Select an entry with `availability.state: "active"`; inspect its input schema.
3. **Call** — `POST /api/v1/tools/{toolName}` with `{ "arguments": { ... } }`.
4. **Verify** — Read the typed result envelope or typed outcome.
5. **If refused** — Follow returned availability; never substitute a tool merely because its name sounds similar.

## Prepare an approvable plan

1. **Discover** — `GET /api/v1/plan-operations`.
2. **Choose** — Use active operations only; keep steps small and one intent coherent.
3. **Call** — Submit `POST /api/v1/plans` with a stable `Idempotency-Key` and accurate display labels.
4. **Verify** — Keep the returned batch ID and review URL. Tell the organizer that a person must review it.
5. **If refused** — Interpret the structured quota or availability outcome before changing the plan.

## Resume after human review

1. **Discover** — `GET /api/v1/pending` or `GET /api/v1/plans/{batchId}`.
2. **Call** — Inspect plan status and recorded step progress.
3. **Verify** — Completed steps stay completed. If a step needs attention, retain its safe outcome in the handoff.
4. **If correction is needed** — Cancel only the untouched remainder or submit a successor plan. Never replay completed steps.

## Handle a locked capability

| Availability | Branch |
| --- | --- |
| `locked_scope` | Name the missing key scope and the supplied owner door. |
| `locked_owner` | Explain that the owner's current authority is narrower; do not promise a key-only fix. |
| `locked_workspace` | Use the named watch tool and human door only when the response returned them. |
| `upcoming` | Use the explicit interim. Do not treat a roadmap entry as callable. |

## Recover from key expiry or revocation

1. **Observe** — Uniform HTTP 401.
2. **Pause** — Do not enumerate keys or ask for a secret in chat.
3. **Human checkpoint** — The owner checks or rotates the key in Settings → API keys and updates the local secret store.
4. **Verify** — Restart at `GET /api/v1/me`.

## Respect quotas and rate limits

A structured quota outcome describes the affected plan limit and may include a hint. HTTP 429 is transport-level pacing: honor `Retry-After` before retrying. Current numeric limits come from `/me`; they are not fixed values to copy into an agent configuration.

## Keep an audit-friendly handoff

Report the task intent, catalog discoveries, calls made, response correlation IDs, plan batch ID and review URL, and any outstanding human action. Exclude API keys and unnecessary sensitive workspace content.
