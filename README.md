# 🐝 Bumblebee

LIMO team's general-purpose Slack bot — the successor to **Optimus**.

Bumblebee runs as a long-running, interactive service that connects to Slack over **Socket Mode** (no public endpoint required) and talks both ways: mention it, message it, or use its slash commands and it responds right in the channel.

When mentioned, Bumblebee answers using **Azure OpenAI** — and it's thread-aware, so it holds a conversation within a thread.

It also posts **scheduled reminders**: a time, some weekdays and a message, stored in SQLite and managed at runtime with `/bee-remind`. No redeploy to add or change one. A reminder can rotate through a roster of people, naming a different host each time it fires.

## Stack

- TypeScript + [`@slack/bolt`](https://slack.dev/bolt-js) (Node 24 LTS)
- Socket Mode (outbound WebSocket, no inbound URL)
- Docker + docker-compose (runs on a self-hosted host)

## Slack app setup (one-time)

Do this once at [api.slack.com/apps](https://api.slack.com/apps):

1. **Create app** → *From scratch* → pick the workspace.
2. **Socket Mode** → enable → generate an **app-level token** (scope `connections:write`). This is your `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions** → add bot scopes: `chat:write`, `app_mentions:read`, `commands`, and — for thread-aware AI replies — `channels:history` (public channels) plus `groups:history` (private channels). *Install to Workspace* → copy the **Bot User OAuth Token**. This is your `SLACK_BOT_TOKEN` (`xoxb-…`). Re-add scopes later → **Reinstall to Workspace**.
4. **Slash Commands** → create `/bee-status`, and `/bee-remind` with **"Escape channels, users, and links sent to your app"** ticked (with Socket Mode no request URL is needed). Without that checkbox Slack sends the literal text `@nuki` instead of a user ID: mentions typed into a reminder message never render, and `host set` can't read a roster at all.
5. **Interactivity & Shortcuts** → **turn Interactivity on**. Socket Mode delivers button clicks over the same WebSocket, but with this toggle off the Approve/Reject buttons render and silently do nothing.
6. **Event Subscriptions** → enable → subscribe to bot event `app_mention`.
7. Invite the bot to a test channel: `/invite @Bumblebee`. Slash commands work in channels the bot was never invited to, but a reminder there can't post.

### App display (optional, for flavor)

- **Short description:** `Optimus's loyal Autobot scout, reporting for duty in Slack — an AI-powered assistant for the LIMO team. 🐝🤖`
- **Background color:** `#111111`

## Configuration

Copy the example and fill in the two tokens:

```bash
cp .env.example .env
```

| Variable                    | Description                                             |
| --------------------------- | ------------------------------------------------------ |
| `SLACK_BOT_TOKEN`           | Bot User OAuth Token (`xoxb-…`)                         |
| `SLACK_APP_TOKEN`           | App-level token for Socket Mode (`xapp-…`)              |
| `LOG_LEVEL`                 | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `AZURE_OPENAI_ENDPOINT`     | Azure OpenAI resource endpoint URL                     |
| `AZURE_OPENAI_API_KEY`      | Azure OpenAI resource API key                          |
| `AZURE_OPENAI_DEPLOYMENT`   | Chat model **deployment** name                         |
| `AZURE_OPENAI_API_VERSION`  | API version (default `2024-10-21`)                     |

## Scheduled reminders

`/bee-remind` manages reminders for the channel you run it in. Times are 24-hour, `Asia/Jakarta`.

```
/bee-remind add standup --at 09:00 --message "Standup time!" \
                        --on monday,tuesday,wednesday,thursday,friday
/bee-remind add sprint  --at 09:00 --message "Sprint planning" --on monday --every-2-week
/bee-remind list · show <code> · edit <code> --… · pause <code> · resume <code>
/bee-remind remove <code> · run <code>
/bee-remind host set standup @alice @bob @cara · host clear <code>
/bee-remind host skip <code> · host next <code> @who
/bee-remind holiday add 2026-08-17 · holiday list · holiday remove 2026-08-17
/bee-remind help
```

- **`--on`** takes `daily` (the default) or full day names — `monday,wednesday`. No ranges, no abbreviations.
- **Cadence** is `--every-1-week` (default), `--every-2-week` or `--every-3-week`. The last two need exactly one day in `--on`, since the gap is measured in days.
- **`--message` needs quotes** whenever it contains a space — `--message "Standup time!"`. Without them only the first word is taken and the rest is rejected as a stray argument, so you get an error rather than a truncated reminder. A slash command is always one line, so use `\n` for a line break: `--message "Standup!\n• Yesterday\n• Today"`.
- **The message posts exactly as stored**, apart from the host line a rotation appends. Type `@someone` or `@channel` to mention them.
- **`run`** posts immediately but still respects holidays and cadence, so it rehearses the real thing. It does ignore `pause`.
- **Holidays are global** — a date added in any channel skips reminders in every channel. `holiday list` shows who added each one and where.

### Host rotation

Give a reminder a roster and it appends `🎙 Host: @someone` to each post, a different person every time.

```
/bee-remind host set standup @alice @bob @cara
```

- **The order is shuffled, and nobody hosts twice until everyone has had a turn.** Each pass is a *lap*: the order is drawn when the lap starts and is visible from then on, so `show <code>` tells you when your turn is coming.
- **`host skip`** moves whoever is up to the back of the lap — they keep their turn, they just aren't up today. **`host next @who`** puts someone up next.
- **`host set` replaces the whole list.** Anyone who already hosted this lap stays hosted, whoever was up stays up, and a new name joins the current lap. The confirmation shows a diff so a name you dropped by accident is visible.
- **`run` uses a turn**, exactly as a real fire does. A post that fails does not.
- `show <code>` prints the whole roster: ✓ for those who have hosted this lap (with the date), → for whoever is up, and the rest below.

**Every command that changes data asks first.** You get a private preview with Approve / Reject; only after Approve does it apply and announce the change in the channel. Confirmations expire after 5 minutes.

## Run locally

```bash
npm install
npm run dev      # tsx watch, hot reload
npm test         # node:test via tsx, pinned to TZ=Asia/Jakarta
```

On start you should see `⚡️ Bumblebee running (socket mode)`.

> ⚠️ **Don't run `npm run dev` while the deployed container is up.** Both connect to Slack with the same tokens, so both run their own scheduler tick and **every reminder posts twice into the real channel**. Use a scratch channel, or stop the container first.

## Run on the deploy host (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

The container uses `restart: always`, so it comes back after reboots.

## Deployment (CI/CD)

Pushes to `main` auto-deploy to the self-hosted host via GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

- **On every PR and push:** typecheck, tests, build, prod-dependency audit, and a gitleaks secret scan, gated by a single required `ci-gate` check.
- **On push to `main` only:** the `deploy` job runs on a **self-hosted runner** labeled `homelab`, builds the image from [compose.prod.yaml](compose.prod.yaml), rolls the container, and healthchecks by confirming the container is running and logged its startup line.

**Deploy host prerequisites (one-time):**

1. Register a self-hosted GitHub Actions runner on this repo with the label `homelab` (Docker available to the runner user).
2. Place the production secrets at **`/opt/bumblebee/.env`** (root-owned, `640`, runner-readable) — same variables as [.env.example](.env.example). `compose.prod.yaml` loads them via `env_file`; nothing flows through GitHub Actions secrets.

### Persistence

State lives in a SQLite database (Node's built-in `node:sqlite`) at `DB_PATH` (default `./data/bumblebee.db`; `/app/data/bumblebee.db` in the container). It records per-request Azure OpenAI token usage, plus reminders, holidays, host rosters and one row per reminder fired — all surfaced via `/bee-status` and `/bee-remind show`.

In production the database is stored in the `bumblebee-data` **Docker named volume** (see [compose.prod.yaml](compose.prod.yaml)), so it survives deploys. A named volume is used deliberately: Docker seeds it from the image's `node`-owned `/app/data`, so the unprivileged container (uid 1000) can write with no host setup — a bind mount would be created root-owned and break SQLite. Inspect or back up the DB with `docker cp bumblebee:/app/data/bumblebee.db .`.

## Verify

1. Logs show `⚡️ Bumblebee running (socket mode)` and **no** `TZ misconfigured` line.
2. `docker exec bumblebee date` prints `WIB` / `+0700`, not UTC — proves `tzdata` made it into the image.
3. In the test channel, `@Bumblebee what's 2+2?` → bot replies in-thread via Azure OpenAI. Ask a follow-up in the same thread → it keeps context.
4. `/bee-status` → status message, AI token-usage summary, and this channel's reminder counts, next fire and last scheduler tick.
5. `/bee-remind add smoke --at <a minute from now> --message "hello"` → Approve → the channel confirms and the reminder posts on the minute.
6. `/bee-remind host set smoke @you @someone-else` → Approve, then `/bee-remind run smoke` three times → a different host each time, each rendering as a real blue mention, and the third rolls the lap over. `/bee-remind show smoke` lists the roster with ✓ / → markers. Then `/bee-remind remove smoke`.

## Project layout

```
src/
├── index.ts            # bootstrap Bolt app (socket mode) + start + scheduler
├── config.ts           # load + validate env
├── ai/
│   └── index.ts        # Azure OpenAI client + generateReply()
├── db/
│   ├── index.ts        # node:sqlite connection + schema migrations
│   ├── ai-usage.ts     # record / summarize AI token usage
│   └── reminders.ts    # reminders, holidays, host rosters + fire history
├── scheduler/
│   ├── index.ts        # startScheduler() — minute tick + fireReminder()
│   ├── clock.ts        # local wall clock + the Jakarta TZ assertion
│   ├── next.ts         # matches / cadenceOk / nextFire (pure)
│   └── rotation.ts     # host lap draw + reordering (pure)
└── listeners/
    ├── index.ts        # register() — wires listeners to the app
    ├── command.ts      # /bee-status slash command
    ├── mention.ts      # app_mention → thread-aware AI reply
    ├── remind.ts       # /bee-remind + Approve/Reject buttons
    ├── args.ts         # flag parsing / validation (pure)
    └── pending.ts      # confirmations awaiting a click (pure)
```
