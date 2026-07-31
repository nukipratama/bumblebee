# 🐝 Bumblebee

The LIMO team's general-purpose Slack bot — successor to **Optimus**.

Bumblebee connects to Slack over **Socket Mode** (an outbound WebSocket, so no public URL and no
ingress to open). It posts **scheduled reminders** that anyone can manage from Slack itself, with
no redeploy.

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
| **Reminder from a message** | ⋮ **More actions** → **Make this a reminder** | Turns a message you already wrote into a schedule, posting it back byte-identical. |
| **Reminder commands** | `/bee-remind list` · `show` · `holiday` | Three read-only commands; creating, editing, running and removing are buttons and dialogs. |
| **Host rotation** | The **Host rotation** field on the reminder form | Appends `🎙 Host: @someone` to each post, a different person each time, nobody twice per lap. |
| **Heads-up** | The **Heads-up** field on the reminder form | Posts an early notice N minutes before, naming the host then — so a handover can happen before the meeting starts. |
| **Skip me** | The button on a rotating reminder | Opens a dialog with an optional reason, shown on the post. The host hands over to the next person; anyone else is just listed as skipping. |
| **Holidays** | `/bee-remind holiday` → pick a date | A date that suppresses reminders in **every** channel. |
| **Status** | `/bee-status` | Uptime line, this channel's reminder count, next fire and last scheduler tick. |
| **Code Freeze reports** | `/bee-cf-report` | Posts one message per configured repo with a button per squad (`All Merged` / `No MR`). Each post updates live as squads click, with a thread reply saying who clicked what. |

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
into a test channel and try `/bee-status`.

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
   | `commands` | the slash commands |
   | `channels:history` | reading the source message for "Make this a reminder", in public channels |
   | `groups:history` | the same, in private channels |
   | `usergroups:read` | listing user groups in the Code Freeze mentions picker |

   Adding scopes later requires **Reinstall to Workspace**.
4. **Slash Commands** → create `/bee-status`, `/bee-remind` and `/bee-cf-report`. Socket Mode needs
   no request URL.
5. **Interactivity & Shortcuts** → turn **Interactivity** on, then **Create New Shortcut** → **On
   messages**, named `Make this a reminder`, with callback ID exactly `remind_from_message`.
   **Reinstall to Workspace** afterwards.
6. `/invite @Bumblebee` into a channel. Slash commands work anywhere, but a reminder can only post in
   a channel the bot has joined.

> [!IMPORTANT]
> Two settings **fail silently** when missed — nothing errors, the feature just does nothing:
>
> - **Interactivity off** → every button and dialog (Approve/Reject, `Skip me`, `Edit`,
>   `+ New reminder`) renders and does nothing.
> - **Callback ID ≠ `remind_from_message`** → the shortcut appears in the ⋮ menu and does nothing.
>
> "Escape channels, users, and links" no longer matters: no command takes a person's name any more —
> rosters are picked in a dialog, which returns real user IDs either way.

<details>
<summary>App display settings (optional, for flavor)</summary>

- **Short description:** `Optimus's loyal Autobot scout, reporting for duty in Slack for the LIMO team. 🐝🤖`
- **Background color:** `#111111`

</details>

## Configuration

Copy `.env.example` to `.env` and fill it in. Every required variable is checked at boot, so a missing
one fails the container immediately rather than at first use.

| Variable | Required | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | ✅ | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | ✅ | App-level token for Socket Mode (`xapp-…`) |
| `LOG_LEVEL` | — | `debug` \| `info` \| `warn` \| `error`, default `info` |
| `DB_PATH` | — | Default `./data/bumblebee.db`; the container uses `/app/data/bumblebee.db` |

Never commit real tokens. In production the secrets live at `/opt/bumblebee/.env` on the deploy host —
nothing flows through GitHub Actions secrets.

## Using it

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

/bee-remind holiday                 the shared list, a date picker to add,
                                    and Remove on each
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
  `holiday` shows who added each one and where.

### The heads-up

Fill in **Heads-up** on the form — a number of minutes — and the reminder posts **twice**: an early
heads-up, then the usual message at its normal time. Leave it empty and nothing changes; that is how
every reminder behaves by default.

```
09:30   Heads Up at 10:25: Daily Standup      <- Heads-up = 55, Heads-up message
        ⚙️ `standup`
        🎙 Host: @alice
        [ Skip me ]

10:25   https://meet.google.com/nkj-aamw-kzb  <- Time = 10:25, Message
        ⚙️ `standup`
        🎙 Host: @alice
        [ Skip me ]
```

- **Time still means the meeting time.** The heads-up counts *back* from it, so setting one never
  moves the post you already have.
- **The host is picked at the heads-up**, which is the point: it opens a window to hand over before
  anyone is in the call. Both posts carry `Skip me`, both show the same host and skip list, and a
  handover on either rewrites both.
- **Heads-up message is required once a heads-up is set**, and is separate from the main message —
  the early post says what the meeting is, the later one carries the link.
- **A heads-up can't reach back past midnight.** A `00:15` reminder tops out at 15 minutes, so both
  posts always land on the same date and see the same holidays.
- **If the bot is down at the heads-up**, the post at the meeting time fires normally instead. That
  day loses its heads-up and its handover window, but nobody loses their turn.
- **A holiday added between the two posts doesn't retract the first.** Mark holidays before the
  heads-up fires.

> [!NOTE]
> **Every command that changes data asks first.** You get a private preview with Approve / Reject;
> only after Approve does it apply and announce the change in the channel. Confirmations expire after
> 5 minutes, are single-use, and only the person who ran the command can click them. The forms are
> the exception: **Create** and **Save** *are* the confirmation, so they apply straight away.

### Host rotation

Give a reminder a roster and each post names a different host.

Pick the roster in the **Host rotation** field on the form — **+ New reminder** or **Edit**. Leaving
it empty means no rotation, and emptying it later clears one.

- **The order is shuffled, and nobody hosts twice until everyone has had a turn.** Each pass is a
  *lap*: the order is drawn when the lap starts and visible from then on, so `show <code>` tells you
  when your turn is coming.
- **`show <code>` carries the lap controls.** **Skip host** moves whoever is up to the back of the
  lap — they keep their turn, they just aren't up today. The picker beside it puts someone up next.
- **Saving the form replaces the whole roster.** Anyone who already hosted this lap stays hosted,
  whoever was up stays up, and a new name joins the current lap.
- **`run` uses a turn**, exactly as a real fire does. A post that fails does not.
- `show <code>` prints the whole roster: ✓ for those who have hosted this lap (with the date), → for
  whoever is up, and the rest below.

### The `Skip me` button

Every rotating reminder posts with a **`Skip me`** button. It opens a dialog with one field — a
reason — which is **optional**: submit it empty and you're simply listed as skipping.

```
⚙️ `standup`
🎙 Host: @alice
🔕 Skip:
• @bob - sick, back tomorrow
• @dana
```

- **The reason sits on the post**, one line per person, in full. Leave the box empty and you're
  listed on your own. A reason is never posted as a thread reply, so it doesn't notify anyone — it's
  a record, not an announcement.
- **Clicking again reopens the dialog prefilled.** Editing rewrites the line; clearing the box
  leaves you listed with no reason.
- **If you're the host**, and it's **within 30 minutes of the meeting time**, the next person in the
  lap takes over. Both posts rewrite themselves to name them, add you to `🔕 Skip:`, and a thread
  reply says so — the one thing that does notify, because someone just picked up the job. **You keep
  your turn** — you go back into the lap, you just aren't up today. After 30 minutes only the
  *handover* is refused: the meeting has effectively happened, and rewriting who was responsible
  would revise history. Everyone else can still skip, with no time limit.
- **Anyone already skipping is passed over**, so a handover never names a host who has said they
  won't be there. They keep their place in the lap — skipping costs nobody a turn. If everyone left
  in the lap has skipped, the post says `⚠️ Nobody available to host` rather than naming someone who
  isn't coming.
- **If you're not the host**, you're added to `🔕 Skip:` and the rotation is untouched. Anyone in the
  channel can do this — you don't have to be on the roster to say you'll be away.

Reminders without a roster don't carry the button — there'd be nobody to hand over to. The button
never hides or relabels itself: a fired reminder is one shared message, so anything it said would be
said to everyone. The dialog is where you learn you're already down as skipping.

### Code Freeze reports with `/bee-cf-report`

`/bee-cf-report` is one entry point, no subcommand args — a settings summary with two buttons:

```
/bee-cf-report
> Code Freeze Report Configuration
> Repos: mamikos-web, mamipay-web, pms, pms-ss, harvest-lct
> Recurring: every weekday at 09:00 (Asia/Jakarta), posts to #mamikos-esls — last run 2026-07-29
>
> [ Edit settings ]  [ Start now ]
```

- **Edit settings** opens a form: the repo list (one per line, replaces the whole list on submit),
  and an optional recurring schedule (days + time). Leaving the days empty means no recurring
  schedule — **Start now** still works manually.
- **The recurring schedule has no separate channel field.** Setting days/time captures whichever
  channel the form was opened from as the schedule's posting channel — that's the only signal a
  scheduler tick, which has no invoking channel of its own, can go on.
- **Start now** posts one message per configured repo into the channel it was run from — never a
  separately configured one — after a native "Are you sure?" confirmation, since it posts several
  real messages at once.
- Each repo's message lists all four squads (`SS`, `LIMO`, `Core BE`, `Core FE`), each with its own
  **All Merged** / **No MR** button pair directly underneath. Anyone can click any squad's button —
  clicking again later just overwrites the latest status. Every click asks for confirmation first,
  rewrites the message in place, and drops a thread reply saying who clicked what.

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
│   ├── code.ts                 reminder-code validation and slug suggestion
│   └── cf.ts                   squads, CfStatus, status formatting for Code Freeze reports
├── store/
│   ├── database.ts             connection, append-only migrations, stmt/transaction helpers
│   ├── reminders.ts            reminders, holidays, rosters, fire history, skips
│   └── cf.ts                   Code Freeze repos, schedule, rounds, messages, responses
├── app/
│   ├── fire.ts                 the single path that posts a reminder
│   ├── scheduler.ts            minute tick, TZ assertion, last-tick state
│   └── cf.ts                   startCfRound — posts one message per repo
└── slack/
    ├── blocks.ts               reminder post, confirmation buttons, list rows
    ├── modals.ts               the reminder form: create · from-message · edit
    ├── cf-blocks.ts             Code Freeze repo post + settings summary blocks
    ├── cf-modals.ts             the Code Freeze settings form
    ├── text.ts                 mrkdwn formatting helpers (pure)
    ├── pending.ts              confirmations awaiting a click
    └── listeners/
        ├── index.ts            wires every listener to the app
        ├── status.ts           /bee-status
        ├── shortcut.ts         "Make this a reminder" → opens the form
        ├── skip.ts             the Skip me button and its reason dialog
        ├── remind/             /bee-remind, split by subcommand family
        │   ├── index.ts        register + subcommand dispatch + Approve/Reject
        │   ├── modal.ts        the form's view handler + New/Edit buttons
        │   ├── reminders.ts    list · show
        │   ├── rotation.ts     Skip host · put someone up next
        │   ├── prompt.ts       raise a confirmation from a button
        │   ├── holidays.ts     the shared list + its date picker
        │   ├── apply.ts        what each approved confirmation actually does
        │   ├── context.ts      the command context shared by the handlers
        │   └── help.ts         /bee-remind help
        └── cf/                 /bee-cf-report and the squad status buttons
            ├── index.ts        register every Code Freeze listener
            ├── settings.ts     /bee-cf-report — the settings summary
            ├── modal.ts        Edit settings form + its view handler
            ├── start.ts        Start now → startCfRound
            └── status.ts       the squad status button click handler
```

Tests live in `tests/`, mirroring the layout of what they cover:

```
tests/
├── domain/                     clock · code · rotation · schedule · cf
└── slack/                      args · blocks · pending · cf-blocks
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
rosters, one row per reminder fired, who skipped each occurrence, and the Code Freeze repo list,
schedule, rounds and per-squad responses — all surfaced through `/bee-status`, `/bee-remind show`
and `/bee-cf-report`.

In production the file sits in the `bumblebee-data` **Docker named volume**, so it survives deploys.
A named volume is deliberate: Docker seeds it from the image's `node`-owned `/app/data`, so the
unprivileged container (uid 1000) can write with no host setup — a bind mount would be created
root-owned and break SQLite. Back it up with `docker cp bumblebee:/app/data/bumblebee.db .`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Buttons render but nothing happens | **Interactivity** is off in the Slack app config. |
| The ⋮ menu item exists but does nothing | The shortcut's callback ID isn't exactly `remind_from_message`. |
| Reminders fire an hour or more off | `TZ` isn't `Asia/Jakarta`. Boot logs a `TZ misconfigured` error; check `tzdata` is in the image. |
| Every reminder posts twice | Two Socket Mode connections on one app token — usually `npm run dev` running against the live container. |
| A reminder never posts | The bot was never invited to that channel, or the date is a holiday, or the cadence gap hasn't elapsed. `/bee-remind show <code>` gives the next fire. |
| Container starts then exits | A required env var is missing; the boot error names it. |

### Verifying a deploy

Do this in a **scratch channel**, and `/invite @Bumblebee` first or nothing can post. Almost every
failure on this surface is silent — a wrong action ID renders fine and does nothing — so each step
says what a failure would mean.

| # | Do | Expect | A failure means |
|---|---|---|---|
| 1 | Container logs | `⚡️ Bumblebee running (socket mode)`, no `TZ misconfigured` | — |
| 2 | `docker exec bumblebee date` | `WIB` / `+0700` | `tzdata` missing from the image |
| 3 | `/bee-remind help` | Four commands, nothing retired | — |
| 4 | `/bee-remind list` in an empty channel | "No reminders yet" **and** `+ New reminder` | Without the button there is no way to create one from scratch |
| 5 | **+ New reminder** → name `smoke`, a minute away, message `hello` → **Create** | Announced in channel, then posts on the minute | No dialog → Interactivity off. Submit does nothing → `callback_id` ≠ `remind_form` |
| 6 | **Edit** on that row | Opens **prefilled** | Blank fields → the prefill path |
| 7 | Add two hosts, **Save**. `show smoke`, note the order. **Edit**, change **only the time**, **Save**, `show` again | Rotation order **unchanged** | A redraw — `plannedEdit` isn't guarding `replaceHosts` |
| 8 | **Run now** → **Approve** | Posts; **the list is still there** above the prompt | The prompt used `replace_original` |
| 9 | `show smoke` → **Skip host** → **Approve** | Up-next moves to the back | — |
| 10 | `show smoke` → the **user picker** → **Approve** | That person is up next | The code isn't round-tripping through `block_id` |
| 11 | `/bee-remind holiday` → pick a date → **Approve**, then **Remove** → **Approve** | Added, then removed | `datepicker` wiring |
| 12 | Post a message with `*bold*` and a real `@mention` → ⋮ → **Make this a reminder** → **Create** | Confirmation threaded on it *and* in-channel; **Run now** posts it byte-identical | Asterisks changed meaning → the body-format rule broke. No dialog at all → missing `channels:history` / `groups:history` |
| 13 | Any fired post | Leads with `⚙️ code` in grey, and a link in the body shows **no preview card** | — |
| 13b | **Skip me** on a fired post → a reason → **Skip**. Click again | Listed under `🔕 Skip:` on its own line **with the reason**; second click opens **prefilled** and rewrites that line | A thread reply instead → the reason is still going to the thread |
| 13c | **Edit** a reminder → **Heads-up** `2`, a heads-up message, time two minutes out → **Save** | Two posts: the heads-up, then the message. Both name the same host, both carry `Skip me` | Only one post → the tick isn't matching the lead time |
| 13d | **Skip me** on the *heads-up* while the host, before the meeting time | Handover accepted; **both** posts rewrite to the replacement | Refused → the window is still measured from the fire, not the meeting |
| 14 | `/bee-remind add foo` | Says where `add` went | — |
| 15 | **Remove** → **Approve**, then `/bee-status` | Gone; status renders | — |

Buttons on a `list` older than ~30 minutes stop responding — Slack expires the slash command's
`response_url` (30 min / 5 uses). Re-run `list`. That is expected, not a regression.
