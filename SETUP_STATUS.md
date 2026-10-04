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
- ai gateway: BLOCKED — requires paid plan / credits (DECISIONS D2). Re-enable `aiGateway: true`
  in `neon.ts`, `neon config apply -y`, `neon env pull`.
- functions / scheduled wake trigger: DEFERRED (in-process scanner locally; `/api/internal/wake-scan`)

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
- managed auth profile: NOT_NEEDED

## Exa
- runtime API key: PRESENT
- smoke search: PASSED (first result: "Perfect Day in Hayes Valley")

## AgentMail
- organization id: `7694e0b9-f8b0-4c58-a184-967991586835`
- inbox: `august-hack@agentmail.to` (verified; can send to anyone)
- webhook: PENDING (needs public URL)
- API key: PRESENT

## Fly Sprites (core, DECISIONS D1)
- org: `august-hack` (Fly login charlieconner04@gmail.com)
- SDK token: PRESENT; API list: HTTP 200
- create: BLOCKED — "Your account is restricted. Please contact billing@fly.io" (needs billing/credits)

## Vercel
- CLI: logged in as `charliec2004`
- project / deployed URL: PENDING
