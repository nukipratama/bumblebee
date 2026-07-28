---
name: bumblebee
description: Project conventions and codebase map for the bumblebee repo — the LIMO team's general-purpose Slack bot (Slack Bolt over Socket Mode + Azure OpenAI), its TS/ESM layout, the branch/PR/CI workflow, and the homelab deploy. Use when writing or reviewing code here, wiring a new Slack listener, touching config/secrets, or when unsure how a change deploys.
---

# bumblebee conventions

Bumblebee is the LIMO team's general-purpose Slack bot, successor to Optimus. It runs as a
long-running container that connects to Slack over **Socket Mode** (outbound WebSocket, no public
endpoint) and replies via **Azure OpenAI**. It also posts **scheduled reminders** from SQLite, managed
at runtime via `/bee-remind`, each optionally rotating through a roster of hosts.

## Layering

Four layers; dependencies only ever point downward. Putting a change in the wrong layer is the main
way this codebase gets messy.

```
slack/  ─┐   Slack adapter: listeners, blocks, message text, arg parsing
app/    ─┤   use cases: fireReminder + the minute-tick scheduler
store/  ─┤   SQLite persistence and schema migrations
domain/ ─┘   pure logic and types: no Slack, no database, no I/O
```

```
src/
├── index.ts                    # bootstrap: Bolt App (socketMode), registerListeners, start, startScheduler
├── config.ts                   # env loading + fail-fast validation
├── domain/                     # pure — imports nothing outside domain/
│   ├── types.ts                # Reminder, NewReminder, Host, Holiday, Fire, NewFire, BodyFormat
│   ├── result.ts               # Parsed<T> + ok/fail
│   ├── clock.ts                # localParts, daysBetween
│   ├── days.ts                 # DAY_NAMES, WEEKDAYS, EVERY_DAY, dayMatches, daysColumn
│   ├── schedule.ts             # matches, cadenceOk, nextFire, cadenceFitsDays, formatCadence
│   ├── rotation.ts             # shuffle, drawLap, drawLapAvoiding, planLap, pendingLap, move*
│   └── code.ts                 # isReminderCode, suggestCode
├── store/
│   ├── database.ts             # connection, migrations array, initDb, stmt(), transaction()
│   ├── reminders.ts            # reminders, holidays, rosters, fire history, skips
│   └── ai-usage.ts             # record / summarize AI token usage
├── app/
│   ├── fire.ts                 # fireReminder — the one path that posts a reminder
│   └── scheduler.ts            # startScheduler, getLastTickAt, the Jakarta TZ assertion
├── ai/index.ts                 # AzureOpenAI client + generateReply() — returns raw Markdown
└── slack/
    ├── blocks.ts               # reminder post blocks + confirm buttons; SKIP/APPROVE/REJECT ids
    ├── text.ts                 # mrkdwn formatting (pure — takes data, never queries)
    ├── args.ts                 # slash-command parsing (pure)
    ├── pending.ts              # PendingAction union + confirmations awaiting a click
    └── listeners/
        ├── index.ts            # registerListeners(app)
        ├── status.ts           # /bee-status
        ├── mention.ts          # app_mention → thread-aware Azure OpenAI reply
        ├── shortcut.ts         # "Make this a reminder" message shortcut → modal → create
        ├── skip.ts             # Skip today button — host handover + out-today list
        └── remind/
            ├── index.ts        # register + subcommand dispatch + Approve/Reject handlers
            ├── reminders.ts    # add · edit · list · show · pause · resume · remove · run
            ├── hosts.ts        # host set · clear · skip · next
            ├── holidays.ts     # holiday add · list · remove
            ├── apply.ts        # applyAction — what each approved confirmation does
            ├── context.ts      # CommandContext, unwrap, requireReminder, readCode
            └── help.ts         # HELP_TEXT
```

- **New rule or calculation** → `domain/`, with a unit test; call it from the listener. Anything a
  listener could get wrong twice belongs here.
- **New Slack behavior** → `slack/listeners/<name>.ts` exporting `register<Name>(app)`, wired in
  `slack/listeners/index.ts`. Keep `index.ts` bootstrap thin.
- **`domain/` must not import `store/`, `slack/` or `app/`.** `store/database.ts` opens the DB and
  `mkdir`s `./data/` at import time, so a domain test importing it would have a filesystem side
  effect. That constraint is what keeps the domain tests fast and hermetic.
- **Config** is centralized in `config.ts`; add new env there with a `required()` check so the
  container fails fast on a missing var rather than at runtime.

## Data rules

- **Schema changes** → *append* a `CREATE TABLE`/`ALTER TABLE` string to the `migrations` array in
  `store/database.ts`. Index = version; never edit an existing entry. Currently 8 entries.
- **DB access** → always via the memoized `stmt()` helper in `store/database.ts`. Never `db.prepare`
  at module top level: the tables don't exist until `initDb()` runs.
- **Host rotation state is one column**: `reminder_hosts.lap_order` is a number while that person is
  pending this lap and `NULL` once they've hosted it. Up next is the lowest number; the lap is over
  when no row has one. There is no pointer column and no "current host" to drift.
- **Only a successful post advances a lap**, via `recordFire`, which stamps `last_fired_at`, writes the
  history row and rewrites the lap in one transaction. Never advance before the post — a Slack failure
  would silently cost someone their turn.
- **Every `/bee-remind` command that writes data goes through Approve/Reject**, and re-validates
  against current state when the button is clicked — state can change between prompt and click. That
  re-read lives in `slack/listeners/remind/apply.ts`.

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
  explaining in prose. Comments are reserved for constraints no identifier can carry — a Slack API
  quirk, an Alpine packaging fact, a "why this order" note. Do not reintroduce comments that restate
  what the code already says.

## Slack specifics

- Reply to the AI with **`chat.postMessage({ markdown_text })`** — Slack renders standard Markdown
  natively, so the model's output needs no mrkdwn conversion. Do **not** re-add a markdown-to-mrkdwn
  library.
- Thread context comes from `client.conversations.replies` (needs `channels:history` +
  `groups:history` scopes); a top-level mention is single-turn.
- Bot scopes live in the Slack app config; the README's "Slack app setup" is the source of truth.
- Three app-config settings are **load-bearing and fail silently** if missed: *Interactivity* must be
  on or every button does nothing; *"Escape channels, users, and links"* must be ticked on
  `/bee-remind` or `@someone` arrives as literal text with no user ID; and the message shortcut's
  callback ID must be exactly `remind_from_message` or the menu item appears and does nothing.
- Slash-command replies use `respond()` (ephemeral) with hand-rolled mrkdwn. Events and actions have no
  `respond()` — use `client.chat.postEphemeral` there.
- Action IDs in `slack/blocks.ts` (`reminder_skip`, `remind_approve`, `remind_reject`) are baked into
  messages already posted in Slack. Renaming one breaks every live button.
- **A reminder's message has a dialect.** `reminders.body_format` is `markdown` for anything typed into
  `/bee-remind` and `mrkdwn` for anything captured from a Slack message. `slack/blocks.ts` renders
  each through the block that reads it as written — `*word*` is italic in one and bold in the other, so
  converting between them silently changes people's text. Never convert; carry the format.

## Config & secrets

- Local: `.env` (gitignored) from `.env.example`. Never commit real tokens.
- Prod (homelab): secrets live at **`/opt/bumblebee/.env`** on the host, mounted into the runner —
  nothing flows through GitHub Actions secrets.
- Required vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` (+ optional `LOG_LEVEL`,
  `AZURE_OPENAI_API_VERSION`, `DB_PATH`).

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
