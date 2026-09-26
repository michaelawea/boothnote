# Architecture

> Read this first, then [`gateway-contract.md`](../gateway-contract.md) (the API) and [`agent.md`](../agent.md) (the AI half). Those two are in Chinese for now.

## 1. Three surfaces that don't depend on each other

```
apps/capture-pwa/     capture   phone PWA for the show floor, offline-first
services/gateway/     gateway   the only write gate between the phone and the CRM (includes the agent)
(official Twenty image) core    data and domain model; its source is never modified
```

**These are stages, not layers.** When layers fail, they fail together. Each stage here keeps running when the others are down:

```
note ──▶ phone IndexedDB ──▶ gateway inbox ──▶ Twenty, after confirmation
      needs no agent      needs no Twenty      needs no signal on the floor
```

If any stage fails, **the stage before it still holds the data.** This is the most important property of the system: what was said during a ten-day show is the one asset that can't be regenerated.

## 2. The journey of one note

```
① Tap and speak on the phone
      │  written to IndexedDB, marked queued      ← "success" already, signal or not
      ▼
② sync.ts retries in the foreground (iOS has no Background Sync)
      │  multipart: payload + audio + photo/image/file
      ▼
③ POST /inbox                                      ← returns 201 in < 3 s, doesn't wait for AI
      │  inbox (append-only) + staging + thread_message + attachment
      ▼
④ Pre-processing, outside the agent
      │  audio → speech-to-text → staging.transcript
      │  attachments → sent to the model natively (input_image / input_file);
      │                 over 10 MB or unsupported → text extraction in a worker thread
      ▼
⑤ The agent (Pi runtime)
      │  15 tools · up to 8 steps (+6 with attachments) · 120 s budget
      │  · approach comes from SKILL.md playbooks (edit without redeploying)
      │  · the same conversation can be resumed · on timeout it writes a partial result
      ▼
⑥ staging.status = ready
      │  a review card appears under the agent's message on the phone
      ▼
⑦ A human reviews, picks the account, confirms   ← the gate: account optional at capture, required here
      │  queued, staging.status = confirming
      ▼
⑧ commitToTwenty() after 5 seconds               ← undo within 5 s = it was never written
         routed by record type: product fitment / support case / project + work items + documents
         every record carries sourceInboxId, so it can be traced back to the original words
```

**Nothing reaches the CRM before step ⑦.** None of the agent's tools can write.

## 3. Module map

### `apps/capture-pwa/` (React + Vite + Dexie, ~111 KB gzip)

| File | What it does |
|---|---|
| `App.tsx` | Five slots: Capture · Accounts · **[AI]** · Records · Me. The middle one isn't a page; it opens a full-screen conversation. Bottom bar on phones, left sidebar at ≥ 900 px, switched in CSS only. UI language follows the account. |
| `pages/QuickNote.tsx` | Default screen: record / type / attach, and the list of my notes. |
| `pages/Chat.tsx` | Full-screen AI conversation. The review card hangs under the agent's message, and that card is what makes this more than a chatbot. |
| `pages/Companies.tsx` | Accounts and their intel gaps. |
| `pages/Board.tsx` | "My records": everything I've captured, grouped by project / time / account. Scoped to the user's own records, admins included. |
| `components/ReviewCard.tsx` | The review card: the single hand-off point between the human and the agent. |
| `db.ts` | Local database, the source of truth on the phone. |
| `sync.ts` | Upload and download, retried in the foreground. |
| `update.ts` | Service-worker registration and version switching. Auto-reload is gated: never while recording, drafting, uploading or in a conversation. |
| `i18n.ts` | Dictionary keyed by the Chinese source string. `t()` must never be evaluated at module load. |
| `recorder.ts` | Container negotiation. iOS before 18.4 only records mp4, so the format can't be hard-coded. |

### `services/gateway/` (Fastify + postgres.js, no build step; Node runs the `.ts` directly)

| File | What it does |
|---|---|
| `index.ts` | All endpoints. The auth hook hits the database on every request, so revoking access takes effect immediately. |
| `confirm.ts` | **The only place in the system that writes to the CRM.** 5-second delayed commit plus a heartbeat. |
| `match.ts` | Name matching (accent-folding, fuzzy). The agent's account lookup and the "new account" duplicate check share it. |
| `twenty.ts` | Twenty client. REST/GraphQL only, never its database tables. |
| `agent/` | See [`agent.md`](../agent.md). |
| `channels/` | DingTalk group bot, router (capture or question?), lab bot. |
| `migrations/` | Numbered `.sql` files, applied in order, recorded in `schema_migrations`. |

### `scripts/`: three sources of truth

| Script | Owns | Runs |
|---|---|---|
| `twenty-schema.mjs` + `provision-twenty.mjs` | Which objects and fields exist in Twenty | after schema changes; on every deploy |
| `provision-views.mjs` / `provision-nav.mjs` | What people see when they open the CRM: columns, sorts, filters, kanban, sidebar | after view changes; on every deploy |
| `backfill-timeline.mjs` | Timeline reconciliation: adds missing events, removes orphans | on every deploy |

All of them are **declarative and idempotent**. Don't configure things by clicking in Twenty's UI: those settings are gone the next time the environment is rebuilt, and nobody will remember why they were set.

## 4. What one record grows into

```
Company
 └─ Opportunity ───── before the deal: can we win it (stage, decision window, budget, competitors)
      └─ Project ──── after nomination: how we deliver (unique code, milestones, samples, SOP)
           ├─ Visit ── one touchpoint
           │    └─ WorkItem ── assignable, with dependencies and two dates
           └─ ProjectDoc ──── source must be explicit: customer spec / AI draft / from dictation
 └─ SupportCase ───── after delivery: from incident to closure
 └─ ProductFitment ── append-only log: shows "said Voltaro in May, switched in July"
```

**Opportunities and projects are separate objects.** An opportunity answers "can we win this"; a project answers "how do we deliver it". Merging them means either losing the pre-sales history when the deal is won, or making one "stage" field mean two things.

**`ProjectDoc.docSource` is the reason that object exists.** If the customer's spec, an AI-written summary and notes taken from dictation all look the same in the CRM, sooner or later someone orders parts from the AI's numbers. So AI-generated documents always start as `DRAFT`, and only a human can mark one "confirmed by customer".

### Two axes between companies. Keep them separate.

| Field | Answers | |
|---|---|---|
| `Company.parentCompany` | who is a subsidiary of whom (the group tree) | |
| `Company.soldVia` | who they buy from (the channel chain: distributor → dealer → end user) | gaps allowed, order can't be reversed |

A company can belong to a group *and* buy through a distributor. Put both in one field and both trees rot in a way you can't untangle later. An integration test asserts that building a channel chain leaves `parentCompany` null.

## 5. Where data lives

| Where | What | Backup |
|---|---|---|
| gateway database (Postgres) | accounts · raw notes · derived data · conversations · attachment metadata · agent traces | `pg_dump` |
| `${GATEWAY_AUDIO_DIR}` | audio and original attachments | **not in pg_dump**; sync it separately |
| Twenty's database | confirmed records | `pg_dump` (a separate database) |

## 6. Three questions that decide most design arguments

1. **"If this row is lost, can it be regenerated?"** This decides whether it gets an append-only trigger. What people said and the photos they took can't be regenerated. Transcripts, parsed text and extractions can be re-run any time.
2. **"How much evidence does this decision need?"** This decides whether the agent or a human makes it. Which account a sentence is about needs one sentence, so the agent decides. Whether a new field deserves a column on everyone's screen needs evidence across accounts, so a human decides.
3. **"Will this check be permanently red on a laptop?"** This decides which test tier it goes in. A check that's always red locally gets ignored quickly, and then it can't protect production either.
