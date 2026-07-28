# 🐝 Bumblebee

The LIMO team's general-purpose Slack bot — successor to **Optimus**.

Bumblebee connects to Slack over **Socket Mode** (an outbound WebSocket, so no public URL and no
ingress to open). It answers questions with **Azure OpenAI** and posts **scheduled reminders** that
anyone can manage from Slack itself, with no redeploy.

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Slack app setup](#slack-app-setup-one-time)
- [Configuration](#configuration)
- [Using it](#using-it)
- [Architecture](#architecture)
- [Development](#development)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## What it does

| Feature | How you use it | Details |
| --- | --- | --- |
| **AI replies** | `@Bumblebee what's 2+2?` | Answers via Azure OpenAI. Thread-aware — ask a follow-up in the same thread and it keeps context. |
| **Reminder from a message** | ⋮ **More actions** → **Make this a reminder** | Turns a message you already wrote into a schedule, posting it back byte-identical. |
| **Reminder commands** | `/bee-remind …` | Add, edit, list, show, remove and test-fire reminders per channel. |
| **Host rotation** | `/bee-remind host set standup @a @b` | Appends `🎙 Host: @someone` to each post, a different person each time, nobody twice per lap. |
| **Skip today** | The button on a rotating reminder | The host hands over to the next person, or anyone marks themselves out for the day. |
| **Holidays** | `/bee-remind holiday add 2026-08-17` | A date that suppresses reminders in **every** channel. |
| **Status** | `/bee-status` | Uptime line, AI token usage, this channel's reminder count, next fire and last scheduler tick. |

Times are 24-hour, **Asia/Jakarta**. Reminder state lives in SQLite and survives restarts.

## Quick start

You need **Node 24+** and a Slack app (see [Slack app setup](#slack-app-setup-one-time) — do that
first if you don't have one).

```bash
git clone <this repo> && cd bumblebee
npm install
cp .env.example .env      # then fill in the tokens
npm run dev
```

You're up when the log reads `⚡️ Bumblebee running (socket mode)`. In Slack, `/invite @Bumblebee`
into a test channel and try `@Bumblebee hello`.

> [!WARNING]
> **Never run `npm run dev` while the deployed container is up.** Both connect with the same tokens,
> so both run their own scheduler tick and **every reminder posts twice into the real channel**,
> unattended. Use a scratch channel, or stop the container first.

## Slack app setup (one-time)

At [api.slack.com/apps](https://api.slack.com/apps):

1. **Create app** → *From scratch* → pick the workspace.
2. **Socket Mode** → enable → generate an **app-level token** with scope `connections:write`. That is
   `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions** → add these bot scopes, then *Install to Workspace* and copy the **Bot User
   OAuth Token** (`SLACK_BOT_TOKEN`, `xoxb-…`):

   | Scope | Needed for |
   | --- | --- |
   | `chat:write` | posting anything at all |
   | `app_mentions:read` | hearing `@Bumblebee` |
   | `commands` | the slash commands |
   | `channels:history` | thread-aware AI replies in public channels |
   | `groups:history` | the same in private channels |

   Adding scopes later requires **Reinstall to Workspace**.
4. **Slash Commands** → create `/bee-status` and `/bee-remind`. Socket Mode needs no request URL.
5. **Interactivity & Shortcuts** → turn **Interactivity** on, then **Create New Shortcut** → **On
   messages**, named `Make this a reminder`, with callback ID exactly `remind_from_message`.
   **Reinstall to Workspace** afterwards.
6. **Event Subscriptions** → enable → subscribe to the bot event `app_mention`.
7. `/invite @Bumblebee` into a channel. Slash commands work anywhere, but a reminder can only post in
   a channel the bot has joined.

> [!IMPORTANT]
> Three settings **fail silently** when missed — nothing errors, the feature just does nothing:
>
> - **Interactivity off** → every button (Approve/Reject, `Skip today`) renders and does nothing.
> - **"Escape channels, users, and links" unticked** on `/bee-remind` → `@nuki` arrives as literal
>   text, so mentions never render and `host set` can't read a roster at all.
> - **Callback ID ≠ `remind_from_message`** → the shortcut appears in the ⋮ menu and does nothing.

<details>
<summary>App display settings (optional, for flavor)</summary>

- **Short description:** `Optimus's loyal Autobot scout, reporting for duty in Slack — an AI-powered assistant for the LIMO team. 🐝🤖`
- **Background color:** `#111111`

</details>

## Configuration

Copy `.env.example` to `.env` and fill it in. Every required variable is checked at boot, so a missing
one fails the container immediately rather than at first use.

| Variable | Required | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | ✅ | App-level token for Socket Mode (`xapp-…`) |
| `AZURE_OPENAI_ENDPOINT` | ✅ | Resource endpoint URL |
| `AZURE_OPENAI_API_KEY` | ✅ | Resource API key |
| `AZURE_OPENAI_DEPLOYMENT` | ✅ | Chat model **deployment** name (not the base model name) |
| `AZURE_OPENAI_API_VERSION` | — | Default `2024-10-21` |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`, default `info` |
| `DB_PATH` | — | Default `./data/bumblebee.db`; the container uses `/app/data/bumblebee.db` |

Never commit real tokens. In production the secrets live at `/opt/bumblebee/.env` on the deploy host —
nothing flows through GitHub Actions secrets.

## Using it

### Asking it things

Mention the bot anywhere it's been invited. A top-level mention is a single question; mention it
inside a thread and it reads that thread first, so follow-ups work.

### Creating a reminder from a message you wrote

The easiest route, and the only one with a real multi-line message box:

1. Write the message in the channel exactly as you want it to post — line breaks, `@mentions`, bold,
   emoji.
2. Hover it → **⋮ More actions** → **Make this a reminder**.
3. Fill in the dialog: name, time (24-hour, to the minute — `09:15`), days, repeat, optional host
   rotation → **Create**.

No quotes, no escaping. The dialog's **Create** button *is* the confirmation, so there's no second
Approve step here. It posts back exactly as written: Bumblebee records that the text came from Slack
and renders it as Slack markup rather than converting it. (`*word*` is bold in a Slack message but
italic in the Markdown a message typed into the form uses — converting would silently change your
text.)

### Managing reminders with `/bee-remind`

`/bee-remind` acts on the channel you run it in.

```
/bee-remind list                    every reminder here, each with Edit,
                                    Run now and Remove, plus + New reminder
/bee-remind show <code>

/bee-remind host set standup @alice @bob @cara · host clear <code>
/bee-remind host skip <code> · host next <code> @who

/bee-remind holiday add 2026-08-17 · holiday list · holiday remove 2026-08-17
/bee-remind help
```

**Creating and editing happen in a dialog, not on the command line.** `+ New reminder` on
`/bee-remind list` opens a blank form; `Edit` on any row opens it prefilled. The time, days and
cadence are pickers, so there are no flags to remember and no quoting rules to get wrong.

- **Cadence** is every 1, 2 or 3 weeks. The last two need exactly one day selected, since the gap is
  measured in days.
- **A name can't be changed once set** — it is how the reminder is looked up, so the Edit form shows
  it rather than offering it. Remove and recreate to rename.
- **The message posts exactly as stored**, apart from the host line a rotation appends. An `@name`
  typed into the form is plain text; to mention someone for real, write the message in Slack and use
  **Make this a reminder**, which keeps the mention intact.
- **Run now** posts immediately but still respects holidays and cadence, so it rehearses the real
  thing. Unlike the form's **Create**/**Save**, the row buttons still ask for Approve first — a
  click is too easy to hit by accident, and **Remove** cannot be undone.
- **Holidays are global** — a date added in any channel skips reminders in every channel.
  `holiday list` shows who added each one and where.

> [!NOTE]
> **Every command that changes data asks first.** You get a private preview with Approve / Reject;
> only after Approve does it apply and announce the change in the channel. Confirmations expire after
> 5 minutes, are single-use, and only the person who ran the command can click them. The forms are
> the exception: **Create** and **Save** *are* the confirmation, so they apply straight away.

### Host rotation

Give a reminder a roster and each post names a different host.

```
/bee-remind host set standup @alice @bob @cara
```

- **The order is shuffled, and nobody hosts twice until everyone has had a turn.** Each pass is a
  *lap*: the order is drawn when the lap starts and visible from then on, so `show <code>` tells you
  when your turn is coming.
- **`host skip`** moves whoever is up to the back of the lap — they keep their turn, they just aren't
  up today. **`host next @who`** puts someone up next.
- **`host set` replaces the whole list.** Anyone who already hosted this lap stays hosted, whoever was
  up stays up, and a new name joins the current lap. The confirmation shows a diff, so a name you
  dropped by accident is visible.
- **`run` uses a turn**, exactly as a real fire does. A post that fails does not.
- `show <code>` prints the whole roster: ✓ for those who have hosted this lap (with the date), → for
  whoever is up, and the rest below.

### The `Skip today` button

Every rotating reminder posts with a **`Skip today`** button. It acts immediately — no confirmation,
since it's one click saying one thing.

- **If you're the host**, and it's **within 30 minutes** of the reminder firing, the next person in
  the lap takes over today. The post rewrites itself to name them, adds you to `🚪 Out today`, and a
  thread reply says so. **You keep your turn** — you go back into the lap, you just aren't up today.
  After 30 minutes the button reports itself closed: the meeting has effectively happened, and
  rewriting who was responsible would revise history.
- **Anyone already marked out is passed over**, so a handover never names a host who has said they
  won't be there. They keep their place in the lap — being out today costs nobody a turn. If everyone
  left in the lap is out, the post says `⚠️ Nobody available to host today` rather than naming
  someone who isn't coming.
- **If you're not the host**, you're added to `🚪 Out today`. No time limit, and it doesn't touch the
  rotation. Anyone in the channel can do this — you don't have to be on the roster to say you'll be
  away.

Reminders without a roster don't carry the button — there'd be nobody to hand over to.

## Architecture

Four layers, and dependencies only ever point downward:

```
slack/  ─┐   Slack adapter: listeners, blocks, message text, arg parsing
app/    ─┤   use cases: fireReminder + the minute-tick scheduler
store/  ─┤   SQLite persistence and schema migrations
domain/ ─┘   pure logic and types: no Slack, no database, no I/O
```

```
src/
├── index.ts                    bootstrap: build the Bolt app, register listeners, start
├── config.ts                   env loading, validated at boot
├── domain/                     pure — every file here is unit-tested in isolation
│   ├── types.ts                Reminder, Host, Holiday, Fire, BodyFormat …
│   ├── result.ts               Parsed<T> — the ok/error shape parsing returns
│   ├── clock.ts                local wall clock, daysBetween
│   ├── days.ts                 the day vocabulary and the stored `days` value
│   ├── schedule.ts             matches / cadenceOk / nextFire / cadenceFitsDays
│   ├── rotation.ts             lap draw and reordering
│   └── code.ts                 reminder-code validation and slug suggestion
├── store/
│   ├── database.ts             connection, append-only migrations, stmt/transaction helpers
│   ├── reminders.ts            reminders, holidays, rosters, fire history, skips
│   └── ai-usage.ts             per-request token accounting
├── app/
│   ├── fire.ts                 the single path that posts a reminder
│   └── scheduler.ts            minute tick, TZ assertion, last-tick state
├── ai/index.ts                 Azure OpenAI client + generateReply()
└── slack/
    ├── blocks.ts               reminder post, confirmation buttons, list rows
    ├── modals.ts               the reminder form: create · from-message · edit
    ├── text.ts                 mrkdwn formatting helpers (pure)
    ├── args.ts                 slash-command parsing (pure)
    ├── pending.ts              confirmations awaiting a click
    └── listeners/
        ├── index.ts            wires every listener to the app
        ├── status.ts           /bee-status
        ├── mention.ts          app_mention → thread-aware AI reply
        ├── shortcut.ts         "Make this a reminder" → opens the form
        ├── skip.ts             the Skip today button
        └── remind/             /bee-remind, split by subcommand family
            ├── index.ts        register + subcommand dispatch + Approve/Reject
            ├── modal.ts        the form's view handler + New/Edit buttons
            ├── reminders.ts    list · show
            ├── hosts.ts        host set · clear · skip · next
            ├── holidays.ts     holiday add · list · remove
            ├── apply.ts        what each approved confirmation actually does
            ├── context.ts      the command context shared by the handlers
            └── help.ts         /bee-remind help
```

Tests live in `tests/`, mirroring the layout of what they cover:

```
tests/
├── domain/                     clock · code · rotation · schedule
└── slack/                      args · blocks · pending
```

Everything with a test is pure, which is the point of the layering: `domain/` and the pure parts of
`slack/` are covered, while `store/`, `app/` and the listeners are the I/O boundary.

Rules that keep the layering honest:

- **`domain/` imports nothing but `domain/`.** That's what makes it testable without a database or a
  Slack client, and it's where the scheduling and rotation rules live.
- **Schema changes are append-only.** Add a statement to the `migrations` array in
  [store/database.ts](src/store/database.ts); its index is its version. Never edit an existing entry.
- **Statements are prepared lazily.** No table exists until `initDb()` runs, so nothing may
  `db.prepare` at module load — use the `stmt()` helper.
- **Only a successful post advances a lap**, via `recordFire`, which stamps `last_fired_at`, writes
  the history row and rewrites the lap in one transaction. Advancing before the post would let a
  Slack failure silently cost someone their turn.
- **Lap state is one column.** `reminder_hosts.lap_order` is a number while that person is pending
  this lap and `NULL` once they've hosted it. Up next is the lowest number; the lap is over when no
  row has one. There is no pointer column and no "current host" to drift.
- **Every writing `/bee-remind` command goes through Approve/Reject**, and re-validates against
  current state on the click — state can change between the prompt and the button.

### Adding to it

- **New Slack behavior** → add `slack/listeners/<name>.ts` exporting `register<Name>(app)` and wire it
  in [slack/listeners/index.ts](src/slack/listeners/index.ts).
- **New rule or calculation** → put it in `domain/` with a unit test, and call it from the listener.
- **New env var** → add it to [config.ts](src/config.ts) with a `required()` check so the container
  fails fast, and to `.env.example`.

## Development

```bash
npm run dev        # tsx watch, hot reload
npm test           # node:test via tsx, pinned to TZ=Asia/Jakarta
npm run typecheck  # tsc --noEmit
npm run build      # emits dist/, excluding tests
```

- **TypeScript, strict, ESM.** Relative imports carry a `.js` extension — required by NodeNext
  resolution.
- **Tests live in `tests/`**, mirroring the `src/` path of whatever they cover — `tests/domain/clock.test.ts`
  tests `src/domain/clock.ts`. `tsconfig.json` typechecks them; `tsconfig.build.json` builds `src/`
  alone, so they never reach `dist/`.
- **Tests run through `tsx`** because Node's own type stripping won't resolve those `.js` specifiers.
  They're pinned to `TZ=Asia/Jakarta`: the scheduler reads the *local* clock, so an untimed test would
  pass or fail depending on the machine.
- **Prefer a name over a comment.** Extract a named constant or helper rather than explaining in
  prose; comments are reserved for constraints no identifier can carry, like a Slack API quirk.
- `main` is branch-protected and **Conventional Commits** are enforced by a `commit-msg` hook (hooks
  auto-enable via the `prepare` script). Branch → PR → `ci-gate` green → merge.

## Deployment

Pushing to `main` deploys automatically via [.github/workflows/ci.yml](.github/workflows/ci.yml):

- **Every PR and push:** typecheck, tests, build, prod-dependency audit and a gitleaks secret scan,
  gated behind a single required `ci-gate` check.
- **Push to `main` only:** the `deploy` job runs on the self-hosted runner labeled `homelab`, builds
  from [compose.prod.yaml](compose.prod.yaml), rolls the container, and healthchecks by confirming the
  startup log line — Socket Mode has no HTTP port to probe.

**Host prerequisites (one-time):** register a self-hosted runner labeled `homelab` with Docker
available to the runner user, and place the production secrets at `/opt/bumblebee/.env` (root-owned,
`640`, runner-readable). `compose.prod.yaml` loads them via `env_file`.

To run it by hand on any Docker host:

```bash
docker compose up -d --build
docker compose logs -f
```

### Persistence

State lives in SQLite (Node's built-in `node:sqlite`) at `DB_PATH`. It holds reminders, holidays,
rosters, one row per reminder fired, who skipped each occurrence, and per-request Azure OpenAI token
usage — all surfaced through `/bee-status` and `/bee-remind show`.

In production the file sits in the `bumblebee-data` **Docker named volume**, so it survives deploys.
A named volume is deliberate: Docker seeds it from the image's `node`-owned `/app/data`, so the
unprivileged container (uid 1000) can write with no host setup — a bind mount would be created
root-owned and break SQLite. Back it up with `docker cp bumblebee:/app/data/bumblebee.db .`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Buttons render but nothing happens | **Interactivity** is off in the Slack app config. |
| `@nuki` shows as plain text; `host set` rejects everyone | **"Escape channels, users, and links"** is unticked on the `/bee-remind` slash command. |
| The ⋮ menu item exists but does nothing | The shortcut's callback ID isn't exactly `remind_from_message`. |
| Reminders fire an hour or more off | `TZ` isn't `Asia/Jakarta`. Boot logs a `TZ misconfigured` error; check `tzdata` is in the image. |
| Every reminder posts twice | Two Socket Mode connections on one app token — usually `npm run dev` running against the live container. |
| A reminder never posts | The bot was never invited to that channel, or the date is a holiday, or the cadence gap hasn't elapsed. `/bee-remind show <code>` gives the next fire. |
| Container starts then exits | A required env var is missing; the boot error names it. |

### Verifying a deploy

1. Logs show `⚡️ Bumblebee running (socket mode)` and **no** `TZ misconfigured` line.
2. `docker exec bumblebee date` prints `WIB` / `+0700` — proves `tzdata` made it into the image.
3. `@Bumblebee what's 2+2?` replies in-thread; a follow-up in that thread keeps context.
4. `/bee-status` returns status, token usage and this channel's reminder state.
5. `/bee-remind list` → **+ New reminder** → name `smoke`, a minute from now, message `hello` →
   **Create** → it posts on the minute. Then **Edit** on that row: the form comes up prefilled.
6. ⋮ → **Make this a reminder** on any message → **Create** → it posts back byte-identical.
7. `/bee-remind host set smoke @you @someone-else` → Approve → **Run now** on that row three times: a
   different host each time, each a real blue mention, and the third rolls the lap over. Then
   **Remove** → Approve. The list it was clicked from should still be there afterwards.
