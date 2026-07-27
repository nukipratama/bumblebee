---
name: bumblebee
description: Project conventions and codebase map for the bumblebee repo — the LIMO team's general-purpose Slack bot (Slack Bolt over Socket Mode + Azure OpenAI), its TS/ESM layout, the branch/PR/CI workflow, and the homelab deploy. Use when writing or reviewing code here, wiring a new Slack listener, touching config/secrets, or when unsure how a change deploys.
---

# bumblebee conventions

Bumblebee is the LIMO team's general-purpose Slack bot, successor to Optimus. It runs as a
long-running container that connects to Slack over **Socket Mode** (outbound WebSocket, no public
endpoint) and replies via **Azure OpenAI**. It also posts **scheduled reminders** from SQLite, managed
at runtime via `/bee-remind`, each optionally rotating through a roster of hosts.

## Codebase map

```
src/
├── index.ts            # bootstrap: build Bolt App (socketMode), register listeners, start(), startScheduler()
├── config.ts           # load + fail-fast validation of env (Slack + Azure vars)
├── ai/index.ts         # AzureOpenAI client + generateReply(messages) — returns raw Markdown
├── db/
│   ├── index.ts        # node:sqlite connection + append-only migrations array
│   ├── ai-usage.ts     # record / summarize AI token usage
│   └── reminders.ts    # reminders, holidays, host rosters + fire history
├── scheduler/
│   ├── index.ts        # startScheduler(app) — minute tick + fireReminder()
│   ├── clock.ts        # local wall clock, daysBetween, assertJakarta
│   ├── next.ts         # matches / cadenceOk / nextFire — pure, no db import
│   └── rotation.ts     # shuffle / drawLap / planLap / move* — pure, no db import
└── listeners/
    ├── index.ts        # register(app) — wires every listener
    ├── command.ts      # /bee-status slash command (status + AI usage + reminder state)
    ├── mention.ts      # app_mention → thread-aware Azure OpenAI reply
    ├── remind.ts       # /bee-remind + the Approve/Reject button handlers
    ├── args.ts         # flag parsing / validation — pure
    └── pending.ts      # in-memory confirmations awaiting a click — pure
```

- **Schema changes** → *append* a `CREATE TABLE`/`ALTER TABLE` string to the `migrations` array in
  `db/index.ts`. Index = version; never edit an existing entry. Currently at `user_version = 5`.
- **DB access** → prepare statements **lazily** (`db/reminders.ts` memoizes by SQL string). Never
  `db.prepare` at module top level: the tables don't exist until `initDb()` runs.
- **Pure modules must not import `db/index.ts`** — it opens the DB and `mkdir`s `./data/` at import
  time, so a test importing it has a filesystem side effect. That's why `next.ts` exists apart from
  `scheduler/index.ts`.
- **Every `/bee-remind` command that writes data goes through Approve/Reject**, and re-validates
  against current state when the button is clicked — state can change between prompt and click.
- **Host rotation state is one column**: `reminder_hosts.lap_order` is a number while that person is
  pending this lap and `NULL` once they've hosted it. Up next is the lowest number; the lap is over
  when no row has one. There is no pointer column and no "current host" to drift.
- **Only a successful post advances a lap**, via `recordFire`, which stamps `last_fired_at`, writes the
  history row and rewrites the lap in one transaction. Never advance before the post — a Slack failure
  would silently cost someone their turn.

- **New Slack behavior** → add a `listeners/<name>.ts` exporting `register<Name>(app)`, then wire it
  in `listeners/index.ts`. Keep bootstrap in `index.ts` thin.
- **Config** is centralized in `config.ts`; add new env there with a `required()` check so the
  container fails fast on a missing var rather than at runtime.

## Language & module conventions

- **TypeScript, strict.** ESM project (`"type": "module"`): **use `.js` extensions in relative
  imports** (e.g. `import { config } from "./config.js"`) — required by NodeNext resolution.
- **Node 24 LTS** (pinned in `.nvmrc`, `Dockerfile`, `engines`).
- Quality gate is `npm run typecheck` + `npm test` + `npm run build`.
- **Tests** use `node:test` run through `tsx` (`npm test`), because Node's own type stripping won't
  resolve the `.js` specifiers this codebase uses. `tsconfig.json` typechecks tests;
  `tsconfig.build.json` excludes them so they never reach `dist/`.
- Tests are pinned to `TZ=Asia/Jakarta` — the scheduler reads the *local* clock, so untimed tests
  would pass or fail depending on the machine.
- **Prefer a name over a comment.** Extract a named constant or helper
  (`JAKARTA_UTC_OFFSET_MINUTES`, `requiredDaysSinceLastFire`, `takeIfFreshAndOwnedBy`) rather than
  explaining in prose. Reserve comments for reasons no identifier can carry — a Slack API quirk or an
  Alpine packaging fact.

## Slack specifics

- Reply to the AI with **`chat.postMessage({ markdown_text })`** — Slack renders standard Markdown
  natively, so the model's output needs no mrkdwn conversion. Do **not** re-add a markdown-to-mrkdwn
  library.
- Thread context comes from `client.conversations.replies` (needs `channels:history` +
  `groups:history` scopes); a top-level mention is single-turn.
- Bot scopes live in the Slack app config; the README's "Slack app setup" is the source of truth.
- Two app-config settings are **load-bearing and fail silently** if missed: *Interactivity* must be on
  or the Approve/Reject buttons do nothing, and *"Escape channels, users, and links"* must be ticked on
  `/bee-remind` or `@someone` arrives as literal text with no user ID.
- Slash-command replies use `respond()` (ephemeral) with hand-rolled mrkdwn. Block Kit is used **only**
  for the confirmation buttons.

## Config & secrets

- Local: `.env` (gitignored) from `.env.example`. Never commit real tokens.
- Prod (homelab): secrets live at **`/opt/bumblebee/.env`** on the host, mounted into the runner —
  nothing flows through GitHub Actions secrets.
- Required vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` (+ optional `LOG_LEVEL`,
  `AZURE_OPENAI_API_VERSION`).

## Local dev

- `npm run dev` (tsx watch). On start expect `⚡️ Bumblebee running (socket mode)`.
- **Never run local dev while the deployed container is up.** Two Socket Mode connections on the same
  app token make the bot reply twice — and now both run their own scheduler tick, so **every reminder
  posts twice into the real channel**, unattended. Use a scratch channel, or stop the container.
- The container sets `TZ=Asia/Jakarta` and installs `tzdata` (Alpine ships none, and without it `TZ`
  is silently ignored). `assertJakarta()` logs an error at boot if the clock isn't UTC+7.

## Workflow & deploy

- `main` is **branch-protected**: no direct commits/pushes (git hooks + GitHub rules enforce it).
  Branch → PR → `ci-gate` green → merge.
- **Conventional Commits** required (`commit-msg` hook). Hooks auto-enable via the `prepare` script.
- CI ([.github/workflows/ci.yml](../../../.github/workflows/ci.yml)): typecheck, test, build, prod
  audit, gitleaks → `ci-gate`. Adding a *step* to the `build` job needs no gate change; adding a new
  **job** means editing both `needs:` and the gate's shell loop. **Push to `main` deploys** on the `[self-hosted, homelab]` runner using
  `compose.prod.yaml` (build → roll → healthcheck; Socket Mode has no HTTP check, so it confirms the
  startup log line).
