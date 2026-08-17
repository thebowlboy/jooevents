# Operate JooEvents on one machine

This guide covers the Bun, SQLite, and local-files installation. It is the operator
path for the first JooEvents release. Until a release tag explicitly says otherwise,
the repository and its rehearsal bundles remain pre-release and must not hold real
event or attendee data.

The service has one writable data directory, one backup destination, one log
directory, and one owner-only environment file. Its public origin terminates HTTPS at
a reverse proxy; the Bun listener stays on loopback.

## Before you begin

Use a release bundle built for the operating system and CPU of the target machine.
The supported runtime is Bun 1.3.6 or newer on Linux or macOS, on x64 or arm64.

Prepare:

- a canonical HTTPS origin such as `https://events.example.org`;
- a Google OAuth web client with that origin under your control;
- an owner email address;
- private, distinct data, backup, and log directories; and
- enough backup space for the complete SQLite database and retained files.

Do not put secrets on a command line. Installation creates an owner-only environment
file with a placeholder; enter the Google client secret directly into that file.

## Build a release bundle

Release publishers build from a clean public checkout. The output path must be an
absolute path that does not exist yet.

```sh
bun install --frozen-lockfile
bun run release:single-machine -- \
  --output /absolute/path/jooevents-RELEASE \
  --release-id RELEASE
```

The builder checks the public/private boundary, builds the live browser application,
copies only publishable source, installs production dependencies, and records every
included digest in `jooevents-release.json`. `--allow-dirty` creates a rehearsal only;
the installer refuses it unless `--allow-rehearsal` is also explicit.

Transfer the whole bundle without changing files. Do not run it from a mutable source
checkout.

## Install

The examples below use this layout:

```text
/opt/jooevents/current/       release bundle (a real directory, not a symlink)
/etc/jooevents/jooevents.env  owner-only configuration
/var/lib/jooevents/           database and blobs
/var/backups/jooevents/       verified backup sets
/var/log/jooevents/           service logs
```

Create the parent directories with the service account as owner and mode `0700`, apart
from the service-manager directory itself. From the release bundle, run:

```sh
bun apps/server/src/entry/operator.ts install \
  --data-directory /var/lib/jooevents \
  --backup-directory /var/backups/jooevents \
  --log-directory /var/log/jooevents \
  --environment-file /etc/jooevents/jooevents.env \
  --service-file /etc/systemd/system/jooevents.service \
  --service-kind systemd \
  --service-user jooevents \
  --service-group jooevents \
  --base-url https://events.example.org \
  --owner-email owner@example.org \
  --google-client-id YOUR_PUBLIC_GOOGLE_CLIENT_ID \
  --admission-mode reservation_only \
  --port 5176
```

The result includes the exact Google callback URL. Add it to the OAuth client, enter
`JOOEVENTS_GOOGLE_CLIENT_SECRET` directly in the environment file, and set
`JOOEVENTS_GOOGLE_CALLBACK_VERIFIED=true` only after the provider console shows the
exact callback.

Check the stopped installation:

```sh
bun apps/server/src/entry/operator.ts doctor \
  --environment-file /etc/jooevents/jooevents.env
```

`doctor` returns JSON. Continue only when `status` is `passed`; retain its non-secret
`databaseId`, because backup and upgrade require that exact safety pin. An explicitly
disabled outbound-email provider is valid for installation, but email-dependent
workflows must not be used until provider readiness has separately passed.

### Start with systemd

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now jooevents.service
sudo systemctl status jooevents.service
```

### Start with launchd

On macOS, choose a direct plist path appropriate to the launch domain and pass
`--service-kind launchd` during installation. For a logged-in user agent:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.joocorp.jooevents.plist"
launchctl kickstart -k "gui/$(id -u)/com.joocorp.jooevents"
```

A headless shell may not own a GUI launch domain. Activate the plist from the actual
login session. For a headless machine, install the plist at
`/Library/LaunchDaemons/com.joocorp.jooevents.plist`, pass both `--service-user` and
`--service-group` during installation, then activate it as an administrator:

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/com.joocorp.jooevents.plist
sudo launchctl kickstart -k system/com.joocorp.jooevents
```

The generated system-domain plist names that user and group explicitly, so launchd
starts as root only long enough to drop to the service account. The release,
configuration, data, backup, and log paths must all be readable or writable by that
account according to their duty.

Verify the running service from the same release bundle:

```sh
bun apps/server/src/entry/operator.ts verify \
  --environment-file /etc/jooevents/jooevents.env
```

This checks retained storage and background work, the live application shell, and the
reserved API boundary on the loopback listener. Also verify the HTTPS origin through
the reverse proxy before inviting anyone.

## HTTPS proxy

Forward the canonical HTTPS origin to `http://127.0.0.1:5176`. Preserve the host and
forwarded-protocol headers, set request and timeout limits, and do not expose the Bun
port publicly. The proxy request-body ceiling must be at least the larger configured
organizer or participant upload limit (250 MiB by default); JooEvents gives JSON and
streaming routes their own narrower application limits. The configured
`JOOEVENTS_BASE_URL` must be the exact browser origin; do not add a path or trailing
slash.

The packaged service binds `127.0.0.1` by default. Do not set
`JOOEVENTS_INTERNAL_HTTP_HOST=0.0.0.0` for an ordinary installation; that explicit
override exists for controlled preview/container networking and makes the Bun port
reachable on every interface allowed by the host firewall.

The single-machine SQLite service admits one backend request to application storage at
a time. It can hold at most 128 additional requests for up to 30 seconds. A request
past either bound receives `503 service_busy` with `Retry-After: 1`; proxies must pass
that response through instead of retrying a mutation themselves. Monitor sustained
`service_busy` responses as a capacity or stalled-request signal. Scale this release
up by giving the one process adequate CPU and fast local storage, not by starting a
second process against the same database.

After proxy changes, repeat `operator verify`, load the sign-in page through HTTPS,
and complete one owner sign-in. A valid auth session does not bypass current access;
the owner admission still has to resolve successfully.

## Back up and rehearse recovery

Complete-install backups are stopped-copy backups. Stop the service first; the command
refuses a live SQLite owner. Choose an absent backup-set path and a byte ceiling larger
than the current database and retained files.

```sh
sudo systemctl stop jooevents.service

bun apps/server/src/entry/operator.ts backup-installation \
  --environment-file /etc/jooevents/jooevents.env \
  --backup-set /var/backups/jooevents/installation-YYYYMMDDTHHMMSSZ \
  --expected-database-id DATABASE_ID_FROM_DOCTOR \
  --max-bytes 21474836480

bun apps/server/src/entry/operator.ts verify-backup \
  --backup-set /var/backups/jooevents/installation-YYYYMMDDTHHMMSSZ \
  --max-bytes 21474836480

sudo systemctl start jooevents.service
bun apps/server/src/entry/operator.ts verify \
  --environment-file /etc/jooevents/jooevents.env
```

Copy the verified backup set off the machine as one unit. The manifest contains
redacted configuration and the names of required secret values, never those values.
Keep the owner-only environment file—or an independently protected secret copy—under
your secret-management policy.

Rehearse into an absent root and a different origin. This never replaces the live
installation:

```sh
bun apps/server/src/entry/operator.ts restore-rehearsal \
  --backup-set /var/backups/jooevents/installation-YYYYMMDDTHHMMSSZ \
  --target-root /srv/jooevents-restore-YYYYMMDD \
  --secret-environment-file /etc/jooevents/jooevents.env \
  --base-url https://restore-check.example.org \
  --service-kind systemd \
  --service-user jooevents \
  --service-group jooevents \
  --port 5276 \
  --max-bytes 21474836480
```

Start the generated service only on the isolated origin, run `operator verify` from
the same release bundle against the restored environment file, and verify an event,
participant, retained file, published page, delivery-history row, and operation-history
row. Record elapsed restore time. With a stopped-copy backup, the application-write
recovery point is the stop time.

## Upgrade

Keep release directories immutable and switch the direct `current` directory name
while the service is stopped. Do not use a symlink: release and service checks resolve
direct paths deliberately.

1. Put the new verified bundle beside `current`, for example
   `/opt/jooevents/jooevents-NEW`.
2. Run its `operator doctor` against the existing environment file.
3. Stop JooEvents and make a complete-install backup.
4. Rename `current` to an untouched rollback name, then rename the new directory to
   `current`. Both renames must stay on the same filesystem.
5. From the new `current`, run:

```sh
bun apps/server/src/entry/operator.ts upgrade \
  --environment-file /etc/jooevents/jooevents.env \
  --expected-database-id DATABASE_ID_FROM_DOCTOR \
  --max-backup-bytes 21474836480
```

The upgrade creates and verifies an additional pre-upgrade SQLite backup before
appending migrations. Start the unchanged service definition, then run `operator
verify`. Keep the old release directory and both backups until the new version has
completed its operational observation window.

If startup fails before any schema change, stop and rename the old release directory
back to `current`. If the database changed, do not point the old binary at it and do
not overwrite the database in place. Keep the service stopped and restore the verified
complete-install backup into a new root; promote that recovered installation only
after its isolated verification passes.

## Diagnose safely

Run `operator doctor` while stopped for configuration, permissions, release integrity,
platform, and database-floor checks. Run `operator verify` while started for the same
checks plus live health and route-boundary checks.

The commands print structured status and opaque identifiers, not secrets. Do not post
the environment file, database, backup manifest plus secret store, or service logs
containing personal event data in a public issue. Security reports should follow
[SECURITY.md](../../SECURITY.md).
