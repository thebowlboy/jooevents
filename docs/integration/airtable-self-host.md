---
title: Connect Airtable to a self-hosted JooEvents installation
subtitle: Register one OAuth integration, store its credentials safely, and verify managed two-way sync.
variant: trailhead
kicker: Airtable
updated: 17 August 2026
---

# Connect Airtable to a self-hosted JooEvents installation

> The installation operator registers Airtable once. After that, workspace owners connect a base from **Integrations → Airtable** without copying tokens or configuring webhooks.

This guide is for an operator—or a coding agent working beside one—who already has a JooEvents installation with a canonical HTTPS origin. It covers the exact provider contract used by JooEvents. It does not turn the current browser sample into a production installation.

## Give this page to your setup agent

> Inspect the installation before asking the operator for information. Determine its canonical HTTPS origin and deployment target, derive the callback URL exactly, and run safe local or deployment checks yourself. Guide the operator one checkpoint at a time. Pause for Airtable login, OAuth registration, consent, and secret entry. Never ask for a client secret, authorization code, callback URL containing OAuth parameters, or encryption key in chat. Never print or commit secret values. Resume from the last verified checkpoint.

The agent may calculate URLs, prepare non-secret configuration, generate the installation encryption key, invoke a concealed deployment-secret prompt, restart services, and verify results. The Airtable account owner must perform the authenticated Builder Hub and authorization steps.

## Before registration

Confirm all of these first:

- The canonical origin is an exact public HTTPS origin such as `https://events.example.org`, with no path or trailing slash.
- Airtable can reach that origin from the public internet. A private LAN, localhost, VPN-only, or tailnet-only address can complete a browser redirect but cannot receive real-time webhook notifications.
- The operator has Airtable Owner or Creator permission.
- The installation provides reachable support, privacy-policy, and terms-of-service pages when people outside the registering Airtable account will connect.

The OAuth callback is always:

```text
https://events.example.org/api/integrations/airtable/oauth/callback
```

Replace only the origin. Do not use an Airtable base URL, the Airtable authorization endpoint, a webhook URL, or a wildcard.

## 1. Register the OAuth integration — operator checkpoint

In Airtable, open **Profile → Builder Hub → OAuth integrations**, then choose **Register an OAuth integration**.

Enter a recognizable installation name and the exact callback URL derived above. Register the integration, then configure:

| Airtable section | Permission |
| --- | --- |
| Record data | Read and write |
| Base schema | Read and write |
| User metadata / email | Read |
| Advanced developer features / webhooks | Manage |

These correspond to the exact scopes requested by JooEvents:

```text
data.records:read
data.records:write
schema.bases:read
schema.bases:write
webhook:manage
user.email:read
```

Add the support email, privacy-policy URL, and terms-of-service URL required by Airtable for other users to authorize the integration. Save the integration and generate its server-side client secret.

Do not put the client secret in chat, source control, issue trackers, command arguments, screenshots, or documentation. Keep the Client ID available for the next checkpoint; it is an identifier, not an authorization token.

Official reference: [Using Builder Hub in Airtable](https://support.airtable.com/articles/9362950318-using-builder-hub-in-airtable).

## 2. Configure the installation

JooEvents requires these names:

| Name | Kind | Purpose |
| --- | --- | --- |
| `JOOEVENTS_BASE_URL` | Non-secret configuration | Canonical HTTPS origin used to derive the callback |
| `JOOEVENTS_AIRTABLE_OAUTH_CLIENT_ID` | Non-secret configuration | Airtable OAuth integration identifier |
| `JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET` | Secret | Server-side OAuth code exchange and refresh |
| `JOOEVENTS_AIRTABLE_SECRET_STORE_KEY` | Secret | Installation-owned 32-byte key, encoded as 43-character base64url |

:::note title="The personal access token is not used"
End users authorize the registered OAuth integration and choose its Airtable resources. A personal access token used during development or provider conformance is not part of the installed connection.
:::

### Single-machine Bun deployment

Store the values in the installation's ignored server environment file or its service manager's secret facility. The setup agent should verify only that each required name exists and has a plausible shape; it must not display the values. Restart the server after configuration changes.

### Cloudflare Workers deployment

Place the origin and Client ID in the Worker's non-secret `vars`. Declare the two sensitive values as required secrets:

```jsonc
{
  "vars": {
    "JOOEVENTS_BASE_URL": "https://events.example.org",
    "JOOEVENTS_AIRTABLE_OAUTH_CLIENT_ID": "your-client-id"
  },
  "secrets": {
    "required": [
      "JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET",
      "JOOEVENTS_AIRTABLE_SECRET_STORE_KEY"
    ]
  }
}
```

Start concealed prompts from the directory containing the Worker configuration:

```sh
bunx wrangler secret put JOOEVENTS_AIRTABLE_OAUTH_CLIENT_SECRET
bunx wrangler secret put JOOEVENTS_AIRTABLE_SECRET_STORE_KEY
```

The operator enters the Airtable secret into Wrangler's prompt. The setup agent may generate and upload the separate 32-byte installation key without displaying it. For staging or another named Wrangler environment, use that environment consistently for configuration, secrets, deployment, and verification.

Cloudflare treats deployed secrets as encrypted environment bindings; the values are hidden after entry. See [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/).

The current public JooEvents release ships a browser-sample Worker, not the complete production Worker/D1/Queue composition. Do not use the sample deployment command as evidence that server-side Airtable sync is installed.

## 3. Connect the selected base — workspace-owner checkpoint

Sign in to the configured JooEvents installation and open **Integrations → Airtable → Connect Airtable**.

Airtable shows the integration's requested permissions and its resource picker. Choose the dedicated base intended for JooEvents. Granting one base is sufficient; do not select an entire workspace or all current and future bases unless that wider access is deliberately required.

After Airtable returns to JooEvents:

1. Choose the visible base by name.
2. Set each area to **Not connected**, **Keep Airtable updated**, or **Work from Airtable**.
3. Confirm **Add JooEvents tables**.

JooEvents inspects the selected base before changing it. It preserves unrelated tables and stops if an existing table collides with a managed table name. The ordinary managed projection creates and maintains JooEvents tables inside the selected base; it does not require the user to find or paste a base ID.

## 4. Verify the two-way loop

Use disposable test records. Do not begin with production event or personal data.

:::steps
1. **Provisioning** — Confirm the integration reaches **Current**, the expected managed tables appear, and an unrelated Airtable table remains unchanged.
2. **Outbound update** — Change one managed JooEvents task or session value, then confirm the corresponding Airtable record updates without duplication.
3. **Allowed inbound update** — Change a speaker task between open and complete in Airtable, wait for settling, and confirm JooEvents applies the same registered task operation once.
4. **Protected field** — Edit a JooEvents-owned field in Airtable and confirm the integration restores the canonical value rather than silently accepting it.
5. **Conflict** — Change the same controlled value independently on both sides and confirm it is held for attention rather than merged by last write.
6. **Recovery** — Use **Sync now**, then pause and resume the connection. Confirm health returns to **Current** without duplicate records.
:::

Real-time inbound verification is complete only when Airtable's webhook requests reach the installation's public HTTPS endpoint. A successful browser callback alone does not prove this.

## Expected boundaries

- JooEvents remains canonical for protected fields.
- **Work from Airtable** enables only the finite controlled fields shown by the UI; it is not permission to write every Airtable cell into application state.
- Speaker cancellation edits become requests rather than silently cancelling an engagement.
- Remote deletion becomes review and restoration, not immediate canonical deletion.
- OAuth tokens and webhook MAC keys remain behind the installation's secret boundary.
- Disconnecting or revoking Airtable access stops synchronization; reconnect replaces the grant while retaining the managed-base anchor when safe.

## If setup refuses

| Symptom | Check |
| --- | --- |
| Airtable reports a mismatched redirect URI | Compare the registered callback and `JOOEVENTS_BASE_URL` character for character, including scheme, host, port, and path. |
| No bases are listed | Edit the Airtable authorization and grant the integration access to the intended base. |
| The base is visible but cannot be selected | The authorizing Airtable user needs edit or creator access for managed schema and records. |
| OAuth succeeds but the connection never becomes current | Check schema-name collisions, required scopes, server logs using the displayed support code, and webhook reachability. |
| Outbound works but Airtable edits arrive late or not at all | Verify the installation is publicly reachable by Airtable and inspect webhook/reconciliation health. |
| Airtable access was revoked | Use **Reconnect** in JooEvents and authorize the same intended base again. |

Never solve a refusal by broadening access to all workspaces without understanding the cause.
