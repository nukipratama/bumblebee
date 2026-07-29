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
slack/  ─┐   Slack adapter: listeners, blocks, modals, message text
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
│   ├── clock.ts                # localParts, daysBetween, minutesSinceMidnight, timeAtMinutes
│   ├── days.ts                 # DAY_NAMES, WEEKDAYS, EVERY_DAY, dayMatches, daysColumn
│   ├── schedule.ts             # matches, matchesLead, leadTime, cadenceOk, nextFire, leadFitsBeforeMidnight
│   ├── rotation.ts             # shuffle, drawLap, drawLapAvoiding, planLap, pendingLap, move*
│   └── code.ts                 # isReminderCode, suggestCode
├── store/
│   ├── database.ts             # connection, migrations array, initDb, stmt(), transaction()
│   ├── reminders.ts            # reminders, holidays, rosters, fire history, skips
│   └── ai-usage.ts             # record / summarize AI token usage
├── app/
│   ├── fire.ts                 # fireReminder (the one fire path) + postJoin
│   └── scheduler.ts            # startScheduler, getLastTickAt, the Jakarta TZ assertion
├── ai/index.ts                 # AzureOpenAI client + generateReply() — returns raw Markdown
└── slack/
    ├── blocks.ts               # reminder post blocks, confirm buttons, the list rows + their ids
    ├── modals.ts               # two views (pure): the reminder form + the skip reason dialog
    ├── text.ts                 # mrkdwn formatting (pure — takes data, never queries)
    ├── pending.ts              # PendingAction union + confirmations awaiting a click
    └── listeners/
        ├── index.ts            # registerListeners(app)
        ├── status.ts           # /bee-status
        ├── mention.ts          # app_mention → thread-aware Azure OpenAI reply
        ├── shortcut.ts         # "Make this a reminder" message shortcut → opens the form
        ├── skip.ts             # Skip me button + reason dialog — host handover, skip list
        └── remind/
            ├── index.ts        # register + subcommand dispatch + Approve/Reject handlers
            ├── modal.ts        # the form's view handler + the New/Edit buttons
            ├── reminders.ts    # list · show
            ├── rotation.ts     # Skip host · put someone up next
            ├── prompt.ts       # askFromRow — raise a confirmation from a button
            ├── holidays.ts     # the shared list + its date picker
            ├── apply.ts        # applyAction — what each approved confirmation does
            ├── context.ts      # CommandContext, unwrap, requireReminder, readCode
            └── help.ts         # HELP_TEXT

tests/                          # mirrors the src/ path of what it covers
├── domain/                     # clock · code · rotation · schedule
└── slack/                      # blocks · modals · pending
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
  `store/database.ts`. Index = version; never edit an existing entry. Currently 15 entries.
- **DB access** → always via the memoized `stmt()` helper in `store/database.ts`. Never `db.prepare`
  at module top level: the tables don't exist until `initDb()` runs.
- **Host rotation state is one column**: `reminder_hosts.lap_order` is a number while that person is
  pending this lap and `NULL` once they've hosted it. Up next is the lowest number; the lap is over
  when no row has one. There is no pointer column and no "current host" to drift.
- **Only a successful post advances a lap**, via `recordFire`, which stamps `last_fired_at`, writes the
  history row and rewrites the lap in one transaction. Never advance before the post — a Slack failure
  would silently cost someone their turn.
- **Every button that writes data goes through Approve/Reject**, and re-validates against current
  state when the button is clicked — state can change between prompt and click. That re-read lives in
  `slack/listeners/remind/apply.ts`. The surviving commands (`list`, `show`, `holiday`, `help`) are
  all read-only; forms write on submit instead, which is their own confirmation.

## Language & module conventions

- **TypeScript, strict.** ESM project (`"type": "module"`): **use `.js` extensions in relative
  imports** (e.g. `import { config } from "./config.js"`) — required by NodeNext resolution.
- **Node 24 LTS** (pinned in `.nvmrc`, `Dockerfile`, `engines`).
- Quality gate is `npm run typecheck` + `npm test` + `npm run build`.
- **Tests live in `tests/`**, mirroring the `src/` path of what they cover —
  `tests/domain/clock.test.ts` covers `src/domain/clock.ts`. Only pure modules have tests; a module
  with no test file is on the I/O boundary.
- **Tests** use `node:test` run through `tsx` (`npm test`), because Node's own type stripping won't
  resolve the `.js` specifiers this codebase uses. `tsconfig.json` includes `src/` + `tests/` and
  carries no `rootDir`; `tsconfig.build.json` adds `rootDir: "src"` and includes `src/` alone, which
  is what keeps `dist/index.js` at the path the Dockerfile's `CMD` expects.
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
- Two app-config settings are **load-bearing and fail silently** if missed: *Interactivity* must be
  on or every button and dialog does nothing; and the message shortcut's callback ID must be exactly
  `remind_from_message` or the menu item appears and does nothing. *"Escape channels, users, and
  links"* used to be a third, but no command takes a person's name any more.
- Slash-command replies use `respond()`, and so do **actions on an ephemeral reply** — a button in a
  `/bee-remind` reply carries a `response_url`, which is what lets `askFromRow` and the Approve/Reject
  handlers reply at all. Actions on a *posted* message (the `Skip me` button) have no `response_url`
  — that path uses `client.chat.update` / `postEphemeral`.
- **Confirm from a button with a fresh ephemeral, never `replace_original`**, or the list the button
  was clicked from is destroyed by its own confirmation.
- **A form's submit is its confirmation.** `add`/`edit` no longer exist as commands: creating and
  editing go through the modal in `slack/modals.ts`, which writes on submit rather than raising an
  Approve/Reject prompt. Single-click buttons still confirm — a click is too easy to hit by accident.
- **Only write a field the form actually changed** — `plannedEdit` in `slack/modals.ts` decides, and
  the listener just executes it. Two writes are not idempotent: `setReminderMessage` resets
  `body_format` to `markdown`, silently reinterpreting a body captured from Slack, and `replaceHosts`
  re-plans the lap, redrawing an order people have already read off `show`.
- **The Skip me button cannot hide or relabel per-person, and that is not a bug.** A fired reminder is
  one shared channel message, so `chat.update` rewrites it for everyone and Slack has no per-viewer
  rendering. Anything the button said after a click would be said to the whole channel, and hiding it
  would break its second job: anyone declaring they're away, independently of the host's handover.
  The `🔕 Skip:` line is the shared confirmation, and the dialog — reopening prefilled and retitled —
  carries the per-person one, because it is the only surface rendered for one viewer.
- **A skip reason lives on the post, never in the thread.** `🔕 Skip:` is a bulleted list, one
  `• @user - reason` line each, so an edit is just a repaint and a long reason wraps under its own
  bullet. Reasons are typed into a `plain_text_input`, so escape `&<>` in `blocks.ts` or
  `<!channel>` in one pings the channel on every repost. **A handover is the one thing that still
  posts a thread reply** — a card edit notifies nobody, and someone just picked up the job.
- **A reminder can post twice.** `reminders.lead_minutes` fires it early with `pre_message` (rendered
  as `Heads Up at {at}: …`); `at` then posts the normal body via `postJoin`. One `reminder_fires` row
  backs both, so `message_ts` **or** `join_message_ts` resolves to it, `repost` rewrites both, and
  each post's body comes from `reminderBody(reminder, which)` — repainting both with one body would
  overwrite the heads-up. The handover window runs to **meeting time + 30 min**, not fire + 30, which
  collapses to the old rule at `lead_minutes = 0`.
- Action IDs in `slack/blocks.ts` (`reminder_skip`, `remind_approve`, `remind_reject`, `remind_new`,
  `remind_edit`, `remind_run`, `remind_remove`) are baked into
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
