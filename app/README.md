# Money Flow v2

Structured tool for AI and human: AI agents/bots operate it through an MCP
bridge; humans use the built-in frontend.

This directory is a Cloudflare Worker (`src/worker/`) plus a React SPA
(`src/ui/`) backed by D1 and KV. After clone you can stand up **your own**
instance on a Cloudflare Free account.

## Public demo (`DEMO_MODE`)

[https://money-flow.arsols.com](https://money-flow.arsols.com) is the **public demo**, not a
production ledger. The demo Worker sets `DEMO_MODE` to `"1"`.

- Each browser gets an `mf_demo_sid` cookie (HttpOnly; Secure on HTTPS) that
  names a `DemoSession` Durable Object. That object holds a private SQLite
  ledger.
- The first touch applies `migrations/0001_initial_schema.sql` and the
  stranger-safe `scripts/seed-demo.sql` (US / UK / DE / CA showcase) inside
  the object. Later reads and writes for that session use only that SQLite
  database.
- The shared `DB` binding may stay in Wrangler for a non-demo deploy or for
  ops. While `DEMO_MODE=1`, ledger queries do not use it.
- Setup and session login still work. Passkey enrollment
  (`/api/auth/register/*`, `/api/v2/passkeys/register-*`, `/setup/passkey`)
  returns 403. Auth and MCP rate limits stay in place; new demo sessions are
  also limited per IP.
- Idle ledgers are deleted after 24 hours. The UI shows that this is a demo
  and that the source is PolyForm Noncommercial.

Self-hosted installs leave `DEMO_MODE` unset and keep using D1.

Bind the object without a Cloudflare account id (Wrangler creates the
namespace on deploy). Example shape, placeholders only:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "DEMO_SESSION", "class_name": "DemoSession" }]
  },
  "migrations": [
    { "tag": "v1-demo-session", "new_sqlite_classes": ["DemoSession"] }
  ],
  "rules": [
    { "type": "Text", "globs": ["migrations/*.sql", "scripts/*.sql"], "fallthrough": true }
  ],
  "vars": { "DEMO_MODE": "1", "APP_DOMAIN": "money-flow.arsols.com" }
}
```

`npm run setup` writes the `DEMO_SESSION` binding into gitignored
`wrangler.local.jsonc` and does **not** turn on `DEMO_MODE`. Set that var
only on the demo Worker. Do not commit real binding ids.

Self-hosting uses `npm run setup` on **your** Cloudflare account. Maintainer
preview aliases are a separate internal path and are not required here.

## Clone → setup → open

```bash
git clone <this-repository>
cd app
npm run setup               # or ./scripts/setup.sh
```

The interactive script (TTY) shepherds a first-time machine: **yes → `npm
install` → Cloudflare login → setup**. You do not need a global Wrangler
install. You can still run `npm install` and `npx wrangler login` yourself
first if you prefer.

The interactive script (TTY) will:

1. Confirm Node.js 20+. If Node is missing or older than 20, it prints how to
   install or upgrade from https://nodejs.org/ and stops (it does not fail
   silently).
2. If `node_modules` or local Wrangler is missing, ask
   **Install dependencies now? [Y/n]** and run `npm install` in `app/`.
   After that it uses `npx wrangler` from this directory.
3. If you are not logged in, offer `npx wrangler login` (browser). A User API
   Token in `CLOUDFLARE_API_TOKEN` also works (email / User Details Read is
   optional).
4. Ask for a Worker / service name (default `money-flow`).
5. Ask for a hostname mode:
   - **Free `*.workers.dev` subdomain** — no custom DNS required.
   - **Custom domain** already in a Cloudflare zone you can edit.
6. Create a D1 database and a KV namespace when they are missing, then write
   **your** binding ids to gitignored `wrangler.local.jsonc` (same shape as
   `wrangler.template.jsonc`; the script does not read that template).
   Re-runs reuse existing D1/KV names instead of failing. On a TTY,
   an existing `wrangler.local.jsonc` prints the Worker name, hostname
   mode, and domain and asks **Reuse this Worker and hostname? [Y/n]**
   before continuing (so name/hostname are not skipped in silence).
7. Apply D1 migrations, then ask **Seed demo data?** (`y`/`N`, default **no**).
   Yes writes a stranger-safe English product showcase: several countries and
   currencies, denser operations for Analytics, planned and recurring items,
   sample transfers, fiscal-receipt fields, and Pulse Warnings examples (an
   already-negative card, an account approaching zero soon, and one that goes
   negative later). Everyday Card at −$640 with a positive household total is
   expected — the forecast total is the sum of all accounts. No leaves the
   instance empty after migrate/deploy.
8. Build the SPA and deploy the Worker + assets.
9. After that first successful code deploy, upload missing Worker secrets
   (`wrangler secret put` deploys immediately, so code must exist first).
   Printed `APP_DOMAIN` / app origin is the resolving
   `<worker>.<account-subdomain>.workers.dev` host, not a versioned deploy URL
   and not the bare `<worker>.workers.dev` name (that hostname does not
   resolve).
10. Print the app origin, the MCP path (`/mcp`), and **both** `SESSION_SECRET`
    and `SETUP_TOKEN` once. Then **always** check that `/mcp` and OAuth
    discovery respond (required after deploy; no chatbot E2E). Setup waits
    with **Waiting for deployment…** until those endpoints are ready.
    HTTP 401 on `/mcp` without a token is expected (OAuth). A failed check
    after the wait is a warning; setup still exits 0 after a successful
    Worker deploy.

Save those two values in a password manager. They are not shown again.

- **SETUP_TOKEN** — first Passkey enroll / recovery at `/setup/passkey`.
  Paste it into the password field on that page (or the login screen). Do
  not put it in a query string.
- **SESSION_SECRET** — session signing key. Do not share it.

If the Worker secrets already exist, a TTY asks whether to rotate them
and print new values. `--yes` leaves them unchanged and prints
`--rotate-secrets` (alias `--rotate-setup-token`). Rotating
`SESSION_SECRET` signs out every session.

Non-interactive / CI flags:

```bash
npm run setup -- --yes --dry-run
npm run setup -- --yes --name money-flow --hostname-mode workers-dev
npm run setup -- --yes --hostname-mode custom --hostname app.example.com
npm run setup -- --yes --seed-demo
npm run setup -- --yes --no-seed-demo
npm run setup -- --yes --rotate-secrets
npm run setup -- --delete cash-desk --yes --dry-run
npm run setup -- --delete cash-desk --yes
npm run setup -- --help
```

`--yes` / CI does not open a browser and does not run `npm install`. If
`node_modules` or local Wrangler is missing, setup fails closed and prints
the exact command `npm install`. If Wrangler is not logged in, it fails
closed and prints the exact command `npx wrangler login`.

`--dry-run` prints the plan and the generated config. It does not create
Cloudflare resources, write secrets, seed data, or deploy. Read-only
account lists (`whoami`, Workers / D1 / KV) still run so reuse and
`--delete` plans can match live resources.

`--seed-demo` / `--no-seed-demo` skip the prompt. `--yes` without either flag
leaves the instance empty (same as `--no-seed-demo`). `SETUP_SEED_DEMO=yes|no`
does the same when the flags are omitted. `--no-seed-demo` wins over the env
var. Re-running `--seed-demo` is a no-op when accounts or operations already
exist.

Re-running setup is safe: existing D1/KV/Worker names are reused. The
script prints that local config is in use (path), that a re-run reuses
the same D1 / KV / Worker, and that starting from scratch means deleting
that file and re-running. A TTY also confirms the existing Worker and
hostname (or lets you change them). Worker secrets are left unchanged
unless they are missing, you confirm rotate on a TTY, or you pass
`--rotate-secrets`. If you seeded demo data, you can wipe it later from
**Data → Reset**.

### Delete a setup install

`npm run setup -- --delete` tears down **one** self-hosted install: the
Worker (secrets and bindings go with it), then the D1 database and KV
namespace that belong to that install, then matching gitignored local
files.

```bash
npm run setup -- --delete                 # TTY: numbered list, pick a digit
npm run setup -- --delete --dry-run       # TTY: pick a digit, print plan, no confirm
npm run setup -- --delete cash-desk       # live TTY: type cash-desk to confirm
npm run setup -- --delete cash-desk --dry-run  # plan only; no confirm; exit 0
npm run setup -- --delete cash-desk --yes # non-interactive / CI
npm run setup -- --delete cash-desk --yes --dry-run
```

**Flags**

| Flag | Effect |
|---|---|
| `--delete [workerName]` | Enter delete mode. Optional name after the flag. `--name` is an alias for the same Worker. |
| `--yes` / `-y` | Skip prompts (including the typed-name confirm). **Requires an explicit Worker name.** |
| `--dry-run` | Print the plan and exit 0. No typed-name confirm, no Cloudflare writes, no local file deletes. Without a Worker name, a TTY still picks a number from the live Worker list. Still lists Workers / D1 / KV from the live account (read-only) so the plan matches a real delete even without `wrangler.local.jsonc`. |
| `--d1-name` / `--kv-name` | Override the default `<worker>-db` / `<worker>-kv` names when they were customized at setup. |
| `--config` | Local wrangler file to read for ownership (default `wrangler.local.jsonc`). Never `wrangler.jsonc`. |

**What is deleted**

1. The Worker script, including Worker secrets (`SESSION_SECRET`,
   `SETUP_TOKEN`) and bindings on that Worker.
2. The D1 database owned by that install — from matching
   `wrangler.local.jsonc` / `.setup-state.json`, or the naming convention
   `<worker>-db` looked up on the account.
3. The KV namespace owned by that install — same ownership rules,
   default title `<worker>-kv`.
4. After a successful remote delete, matching gitignored
   `wrangler.local.jsonc` and `.setup-state.json` for that Worker.

**What is not deleted**

- Resources referenced by the committed production `wrangler.jsonc`
- Reserved production Worker, preview-alias, and D1 names
- Reserved production resource ids and hosts
- Other Workers, D1 databases, or KV namespaces on the account
- 1Password items (out of scope)
- Custom-domain DNS records in your zone (remove those in the dashboard
  if you attached a hostname)

**Safety**

- The private repository's reserved production inventory is isolated in
  `scripts/lib/cloudflare-setup/private-reserved-names.mjs`. The setup runtime
  enforces that overlay, while its help, plans, and errors use neutral wording
  that is safe to copy into a public distribution.
- On a live TTY delete the script prints the plan and requires you to
  **type the Worker name**. A lone `y` is not enough.
- `--dry-run` prints that plan and exits 0 without the typed-name confirm.
  `--delete --dry-run` with no name still waits for a number on a TTY.
  It still runs read-only account lists so owned `<worker>-db` /
  `<worker>-kv` (or matching local config) appear when those resources
  exist on the account.
- `--yes` skips confirm for a live delete and still refuses reserved production names.
- Delete prefers resources **owned by / named for that install**. A
  local config for Worker A is not used when deleting Worker B.
- Interactive `--delete` without a name lists account Workers plus
  relevant local / `<name>-db` names, numbered. Reserved names appear as
  `[protected — production]` and cannot be chosen.

This is the self-host teardown path. It is separate from the repository's
private preview deployment tooling and must not target reserved environments.

### After deploy

1. Open the printed **app origin** (`https://<worker>.<account>.workers.dev`).
2. Enroll a Passkey. Paste `SETUP_TOKEN` into the password field on
   `/setup/passkey` (or the login screen). Do not put the token in `?token=`.
3. Save **both** `SETUP_TOKEN` and `SESSION_SECRET` in a password manager.
   `SESSION_SECRET` is the session signing key — do not share it.
4. Point an MCP client at `https://<your-origin>/mcp` after you create an
   OAuth client in the app. Setup already checked that `/mcp` and OAuth
   discovery respond; a warning there means the Worker may still be
   propagating — open the app origin in a browser.

Local config files (gitignored): `wrangler.local.jsonc`, `.setup-state.json`,
`.dev.vars`. Do not commit them. Do not copy ids from a committed production
`wrangler.jsonc`.

Redeploy later with `npm run deploy:local` (uses `wrangler.local.jsonc`).

## Wrangler configs

| File | Who uses it |
|---|---|
| `wrangler.jsonc` | Committed production / CI configuration for this private repo. Contains that account's binding ids. |
| `wrangler.template.jsonc` | Documentation-only shape for a self-hosted Worker. Placeholder ids. `npm run setup` does not read this file. |
| `wrangler.local.jsonc` | Generated by `npm run setup` (`buildLocalWranglerConfig`) using the same shape. Gitignored. |

Forks should treat committed `wrangler.jsonc` ids as not theirs. Always run
setup and deploy with `--config wrangler.local.jsonc`.

## Manual smoke checklist (Cloudflare Free)

Use a real Cloudflare account later (owner or bot). Unit tests do not log in.

1. `cd app && npm run setup` (confirm `npm install` and login if asked)
   on your own Free plan Cloudflare account. Or run `npm install` and
   `npx wrangler login` yourself first.
2. Choose workers.dev and the default Worker name (or a unique name if
   `money-flow` is already taken on that account).
3. Confirm D1 (`<name>-db`) and KV (`<name>-kv`) exist in the dashboard.
4. Confirm `wrangler.local.jsonc` has **your** ids, not committed production ids.
5. Open the printed app URL — login / Passkey setup loads with no console
   errors that block the page.
6. Confirm the success banner printed **both** `SESSION_SECRET` and
   `SETUP_TOKEN`. Save them in a password manager.
7. Enroll a Passkey using the printed `SETUP_TOKEN`.
8. If you answered yes to **Seed demo data?**, confirm accounts in more than
   one country (Everyday Checking, Rhine Checking, Sterling Current, Maple
   Everyday, plus savings/card/travel cash), planned and recurring items, and
   enough operations for Analytics charts. If you answered no (the default),
   create one account and one test operation.
9. Open `/mcp` — the MCP endpoint is reachable on the same origin.
10. Re-run `npm run setup -- --yes` — it reuses the same D1/KV/Worker and redeploys.
    If you lost the secrets, use `--rotate-secrets` (or confirm rotate on a TTY).
11. Optional: `--hostname-mode custom --hostname <host-in-your-zone>`. If
    Wrangler cannot attach the hostname, follow the printed zone steps and
    add the Custom Domain under Workers → Settings → Domains & Routes.
12. Optional teardown: `npm run setup -- --delete <name> --dry-run` to
    print the plan with no confirm, then `--delete <name>` (type the
    Worker name) or `--delete <name> --yes`. Confirm the Worker, D1,
    and KV are gone. Reserved production names and ids must be refused.

## Development

```bash
npm run build
npx wrangler dev --port 8787
npm run check
npm test                  # vitest (workerd) + setup-script unit tests
npm run test:setup        # unit + mocked live-path tests; no live Cloudflare
```
