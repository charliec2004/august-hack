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
