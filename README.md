# 🐝 Bumblebee

LIMO team's general-purpose Slack bot — the successor to **Optimus**.

Bumblebee runs as a long-running, interactive service that connects to Slack over **Socket Mode** (no public endpoint required) and talks both ways: mention it, message it, or use its slash commands and it responds right in the channel.

When mentioned, Bumblebee answers using **Azure OpenAI** — and it's thread-aware, so it holds a conversation within a thread.

## Stack

- TypeScript + [`@slack/bolt`](https://slack.dev/bolt-js) (Node 24 LTS)
- Socket Mode (outbound WebSocket, no inbound URL)
- Docker + docker-compose (runs on the homelab)

## Slack app setup (one-time)

Do this once at [api.slack.com/apps](https://api.slack.com/apps):

1. **Create app** → *From scratch* → pick the workspace.
2. **Socket Mode** → enable → generate an **app-level token** (scope `connections:write`). This is your `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions** → add bot scopes: `chat:write`, `app_mentions:read`, `commands`, and — for thread-aware AI replies — `channels:history` (public channels) plus `groups:history` (private channels). *Install to Workspace* → copy the **Bot User OAuth Token**. This is your `SLACK_BOT_TOKEN` (`xoxb-…`). Re-add scopes later → **Reinstall to Workspace**.
4. **Slash Commands** → create `/bumblebee` (with Socket Mode no request URL is needed).
5. **Event Subscriptions** → enable → subscribe to bot event `app_mention`.
6. Invite the bot to a test channel: `/invite @Bumblebee`.

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

## Run locally

```bash
npm install
npm run dev      # tsx watch, hot reload
```

On start you should see `⚡️ Bumblebee running (socket mode)`.

## Run on the homelab (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

The container uses `restart: always`, so it comes back after reboots.

## Deployment (CI/CD)

Pushes to `main` auto-deploy to the homelab via GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

- **On every PR and push:** typecheck, build, prod-dependency audit, and a gitleaks secret scan, gated by a single required `ci-gate` check.
- **On push to `main` only:** the `deploy` job runs on a **self-hosted runner** labeled `homelab`, builds the image from [compose.prod.yaml](compose.prod.yaml), rolls the container, and healthchecks by confirming the container is running and logged its startup line.

**Homelab prerequisites (one-time):**

1. Register a self-hosted GitHub Actions runner on this repo with the label `homelab` (Docker available to the runner user).
2. Place the production secrets at **`/opt/bumblebee/.env`** (root-owned, `640`, runner-readable) — same variables as [.env.example](.env.example). `compose.prod.yaml` loads them via `env_file`; nothing flows through GitHub Actions secrets.

## Verify

1. Logs show `⚡️ Bumblebee running (socket mode)` with no auth errors.
2. In the test channel, `@Bumblebee what's 2+2?` → bot replies in-thread via Azure OpenAI. Ask a follow-up in the same thread → it keeps context.
3. `/bumblebee` → bot responds with a status message.

## Project layout

```
src/
├── index.ts            # bootstrap Bolt app (socket mode) + start
├── config.ts           # load + validate env
├── ai/
│   └── index.ts        # Azure OpenAI client + generateReply()
└── listeners/
    ├── index.ts        # register() — wires listeners to the app
    ├── command.ts      # /bumblebee slash command
    └── mention.ts      # app_mention → thread-aware AI reply
```
