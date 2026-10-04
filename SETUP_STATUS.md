# Setup Status

Non-secret identifiers only. Secrets live in `.env.local` (gitignored, mode 600) and
provider credential stores. Never paste token values here.

## Repository
- status: READY — public repo https://github.com/charliec2004/august-hack (default branch `main`)
- branch: `t3code/end-to-end-agent-handoff`

## Neon
- status: READY (Free plan)
- org: `org-weathered-brook-10060368`
- project: `august` (`fragrant-block-08833674`), region `aws-us-east-2`, Postgres 18
- branch: `production` (`br-raspy-glitter-b5iq98tk`)
- CLI profile: `august` (org-scoped API key, `~/.config/neon/credentials.august.json`)
- migrations: 001_initial, 002_memory (pgvector), 003_computers_and_mail — APPLIED
- auth (Managed Better Auth): READY (provisioned; app uses demo identity for P0)
- object storage: READY — bucket `august-artifacts` (private)
- ai gateway: credential + base URL PRESENT locally and in Vercel; requests 403 until the org is on a
  paid plan (DECISIONS D2). After upgrading: `NEON_PLAN_PAID=true neon deploy --env .env.local`.
- functions: `wakescan` (calls `/api/internal/wake-scan` with CRON_SECRET); trigger `wake-scan` every minute — READY
- test branch: `test` (`br-floral-smoke-b5bfx9ol`) for integration tests

## Executor
- status: READY
- org slug: `august`
- MCP endpoint: `https://executor.sh/mcp` (bearer PAT)
- connected: Google Calendar (`google_calendar.user.personalGoogleCalendarApi`) via own GCP OAuth
  client in project `august-hack`; test user charlieconner04@gmail.com
- Google Calendar API must be ENABLED in GCP project `august-hack` (was disabled → 403)
- runtime PAT: PRESENT

## Kernel
- status: READY — runtime API key PRESENT, smoke: list browsers HTTP 200
- run browser: one live stealth session per worker run (CAPTCHA solver, user profile, vault linked), lifecycle in `browser_sessions`; interactive live view (user can take control)
- saved logins: Kernel Vaults project vault `august-logins` (items keyed by `vault_items.id`, D3); `/api/vault` GET/POST/DELETE
- profiles: one per user `august-u-<userId>`, single writer via `browser_profile_leases`
- verified live 2026-10-04: vault add -> `vault_sign_in` on the-internet.herokuapp.com/login reached "/secure" (no password in tool output/DB); sign-in persisted to a new browser via profile; download of `student.json` (7951 B) stored as a verified artifact; reconcile closed an abandoned run's session (Kernel 404 after)
- managed auth connections: NOT_USED (see D3)

## Exa
- runtime API key: PRESENT
- smoke search: PASSED (first result: "Perfect Day in Hayes Valley")

## AgentMail
- organization id: `7694e0b9-f8b0-4c58-a184-967991586835`
- inbox: `august-hack@agentmail.to` (verified; can send to anyone)
- webhook: `ep_3KF63Tzv4rRIkv3vLJCWVDAxcXV` → https://august-hack.vercel.app/api/webhooks/agentmail (message.received); secret in env
- API key: PRESENT

## Fly Sprites (core, DECISIONS D1)
- org: `august-hack` (Fly login charlieconner04@gmail.com)
- SDK token: PRESENT; API list: HTTP 200
- create: BLOCKED — "Your account is restricted. Please contact billing@fly.io" (needs billing/credits)

## Vercel
- CLI: logged in as `charliec2004`
- project: `august-hack` (`prj_JLES2Y7mR37UAGhdSULrOrap7uR1`), framework nextjs, SSO protection off
- deployed URL: https://august-hack.vercel.app (AUGUST_ENV=demo → demo controls visible)
