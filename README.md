<img src="assets/icon.svg" width="64" height="64" alt="">

# August

**A personal agent that owns outcomes over time.** Hand August what you don't want to keep
remembering and chasing. It takes ownership, does the work in the background, waits when the
world isn't ready, wakes itself back up, asks only when it genuinely needs you, and finishes
with evidence.

Built for Build Personal Agents Hack (October 4, 2026).

## Run it

```bash
npm install
npm run db:migrate      # applies migrations/*.sql to the linked Neon branch
npm run dev             # http://localhost:3000
```

`.env.local` must hold the values named in [`.env.example`](.env.example). Neon values come
from `neon env pull`; see [`SETUP_STATUS.md`](SETUP_STATUS.md) for which resources exist.
The dev server runs an in-process wake scanner every 20s; in deployment a scheduled trigger
calls `POST /api/internal/wake-scan` (bearer `CRON_SECRET`).

## Demo

1. `npm run demo:reset` (or **Reset demo** in the sidebar) clears only the demo user's rows.
2. Ask: *"Find a good dinner for two tonight around 7 near Hayes Valley, stay under $120, don't
   conflict with my calendar, and if nothing good is available keep checking. Ask me before you
   book anything."*
3. August acknowledges and the item appears under **What August owns**. In the background a
   Worker reads your calendar (Executor), researches (Exa), and checks live pages (Kernel; use
   **Watch browser**).
4. If nothing fits yet, the item shows **Checking again later** with the next check time. The
   wake is a real row in Postgres.
5. **Run next check now** pulls that persisted wake forward through the real claim and resume
   path. Time is accelerated; nothing else is.
6. When there's a viable option, the commitment (booking, or an email to the restaurant from
   August's AgentMail inbox) appears as an **approval card** rendered from the frozen proposal.
7. Approve. The exact proposal hash executes once, the provider receipt is stored, and the
   responsibility completes.

## Checks

```bash
npm test                 # unit + integration (integration runs on the Neon `test` branch)
npm run smoke:providers  # Exa, Executor, Kernel, AgentMail (non-destructive)
npm run smoke:sprites    # Fly Sprites create/exec/destroy
```

## How it works

| Layer | Owns |
|---|---|
| Neon Postgres | Responsibilities, events, workers, wakes, effects, approvals, receipts, evidence, computers, user environments |
| Brain Core (Mastra) | The conversation, ownership decisions, final wording. The only voice. |
| Workers (Mastra) | Scoped assignments with capability-scoped tools; report upward, never to the user |
| Exact-effect rail | Every external mutation: classify, freeze, hash, review (fails closed), approval bound to hash, execute once, receipt |
| Exa / Executor / Kernel / AgentMail | Research, your connected apps, real websites, outside-world email |
| Fly Sprites | Isolated per-session computers; the user's environment manifest is canonical in Postgres, the bundle in Neon Object Storage |
| assistant-ui | Conversation, what August owns, approval cards, activity |

Invariants: Postgres is the only durable source of truth. Capability is not authority. Memory,
web pages, emails, and worker reports never authorize anything. Completion requires a receipt
or evidence, never a model sentence. Uncertain outcomes are reconciled by readback, never
blindly retried. See [`DECISIONS.md`](DECISIONS.md) for deviations from the original spec.
