# Decisions

Genuine deviations from the August spec only.

## D1. Fly Sprites promoted from P2 to core (2026-10-04)

**Spec:** Sprites is P2 ("only after demo is stable"; omit if time is short).
**Decision:** Sprites is a core Worker capability. Workers can be allocated isolated
Linux computers, including many in parallel, pre-provisioned with task tooling
(e.g. a DoorDash CLI) for work that has no clean API.
**Why:** Product owner direction: per-Worker computers are central to what August
should be able to do, not a capability demo.
**Invariants kept:** a Sprite is still never the source of durable state; durable
outputs go to Neon Object Storage with hashes in Postgres; mutations performed from
a Sprite (e.g. placing an order via CLI) are consequential effects and must pass the
exact-effect rail before the committing command runs; no provider credentials stored
on Sprite disks.

## D2. AI Gateway disabled in neon.ts until the org is on a paid plan (2026-10-04)

**Spec:** inference goes through Neon AI Gateway.
**Situation:** the Neon org is on the Free plan; `neon config apply` refuses `aiGateway: true`
because the gateway does not serve requests on Free.
**Decision:** keep the single model adapter pointed at the AI Gateway (OpenAI-compatible
`$NEON_AI_GATEWAY_BASE_URL/v1`); re-enable `aiGateway: true` and `neon env pull` once the
org is upgraded / event credits are applied. No alternate inference vendor is introduced.

## D3. Saved logins use Kernel Vaults fill, in one project vault (2026-10-04)

**Direction:** a per-user vault of site logins; August signs in in its Kernel browser
without the model seeing the password, using Kernel primitives (profiles, managed
auth/credentials, stealth).
**Decision:** secrets live in Kernel Vaults credential items (`vaults.items.upsert`,
password field `sensitive`); sign-in is `vaults.items.performOperation({ type: "fill" })`
into August's live browser, then August presses Enter. Managed Auth connections
(`auth.connections.*`) were not used: they run their own login browser, so the sign-in
would not happen in the session the user is watching, and add health-check cost.
Saved sign-ins persist through one Kernel profile per user (`profiles`, `save_changes`
only for the single writer lease holder). Stealth mode (CAPTCHA solver) is on for the
run browser and for prepare/commit sessions.
**Deviation:** items live in ONE project vault (`KERNEL_VAULT_NAME`, default
`august-logins`) keyed by `vault_items.id`, not one Kernel vault per user, because the
Kernel free plan caps an org at 3 vaults. Per-user ownership is enforced in Postgres
(every lookup is `user_id`-scoped; only server code chooses the item key), and the
exact-origin binding is enforced by August before every fill (Kernel credential items
have no destination allowlist). Revisit per-user vaults on a paid Kernel plan.
