# Working on Boothnote

Guidance for contributors and coding agents. Architecture: [`docs/en/architecture.md`](docs/en/architecture.md).

## Rules that are not style preferences

1. **Don't modify Twenty, fork it, or touch its database tables.** Use the Metadata API and REST/GraphQL only. Twenty's fields are metadata-driven, and writing around the API corrupts data in ways that are very hard to spot.
2. **`inbox` is append-only.** A trigger rejects `UPDATE`/`DELETE`. Transcripts and extractions are derived: they go to `staging` and never back into `inbox`.
3. **Relation fields are an existing UUID or `null`, never a name.** When the agent thinks it has found a new account it fills `suggested_company`. It suggests; it never creates.
4. **The PWA never talks to Twenty.** The only Twenty API key lives in the gateway, and scope filtering happens server-side.
5. **Credentials never go into Twenty.** `app_user` in the gateway database is the source of truth; Twenty's `contributor` is a projection.
6. **Account attribution is optional at capture and required at commit.**
7. **No RBAC engine.** There are four role names but only two checks: `canSeeBoard = role !== 'user'`, `canManageUsers = role === 'admin'`.
8. **The agent gets no write tools.** A snapshot test pins the exact tool list; adding a tool is a reviewed change.

## Commands

```bash
./scripts/test.sh                 # types + unit + build + guards (seconds, no services)
./scripts/test.sh all             # + integration tests in a disposable Postgres + gateway (Docker)
node scripts/check-schema-drift.mjs --update   # after an intentional schema change
node scripts/provision-views.mjs  # preview view changes; add --yes to apply
```

- **Adding a zero-dependency gateway test file?** Also add it to `units()` in `scripts/test.sh`. That tier lists files one by one; the PWA tier uses a glob.
- **Adding a new guard script to `test.sh`?** Wrap it in `run`, then break something on purpose and check that the whole suite goes red.
- **Changing the data model or a cleanup script?** Open the app in a browser afterwards. Passing tests and a correct page are different claims.

## Conventions

- Code comments are mostly Chinese; English is welcome. `console.*` output isn't translated (it's for developers).
- User-facing strings go through `t()` in `apps/capture-pwa/src/i18n.ts`, keyed by the Chinese source text. Never evaluate `t()` at module load.
- Anything the business can tune (accounts, competitors, intel checklist, speech vocabulary, agent playbooks) is **data, not code**: `data/*.json` and `services/gateway/agent/skills/*/SKILL.md`. Changing those needs no release.
