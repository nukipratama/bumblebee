---
name: bumblebee
description: Project conventions and codebase map for the bumblebee repo — the LIMO team's general-purpose Slack bot (Slack Bolt over Socket Mode + Azure OpenAI), its TS/ESM layout, the branch/PR/CI workflow, and the homelab deploy. Use when writing or reviewing code here, wiring a new Slack listener, touching config/secrets, or when unsure how a change deploys.
---

# bumblebee conventions

Bumblebee is the LIMO team's general-purpose Slack bot, successor to Optimus. It runs as a
long-running container that connects to Slack over **Socket Mode** (outbound WebSocket, no public
endpoint) and replies via **Azure OpenAI**. Milestone 0 is the interactive foundation;
reminders/rotations (ported from Optimus) come in later milestones.

## Codebase map

```
src/
├── index.ts            # bootstrap: build Bolt App (socketMode), register listeners, start()
├── config.ts           # load + fail-fast validation of env (Slack + Azure vars)
├── ai/index.ts         # AzureOpenAI client + generateReply(messages) — returns raw Markdown
└── listeners/
    ├── index.ts        # register(app) — wires every listener
    ├── command.ts      # /bumblebee slash command (status reply)
    └── mention.ts      # app_mention → thread-aware Azure OpenAI reply
```

- **New Slack behavior** → add a `listeners/<name>.ts` exporting `register<Name>(app)`, then wire it
  in `listeners/index.ts`. Keep bootstrap in `index.ts` thin.
- **Config** is centralized in `config.ts`; add new env there with a `required()` check so the
  container fails fast on a missing var rather than at runtime.

## Language & module conventions

- **TypeScript, strict.** ESM project (`"type": "module"`): **use `.js` extensions in relative
  imports** (e.g. `import { config } from "./config.js"`) — required by NodeNext resolution.
- **Node 24 LTS** (pinned in `.nvmrc`, `Dockerfile`, `engines`).
- No test framework yet; quality gate is `npm run typecheck` + `npm run build`.

## Slack specifics

- Reply to the AI with **`chat.postMessage({ markdown_text })`** — Slack renders standard Markdown
  natively, so the model's output needs no mrkdwn conversion. Do **not** re-add a markdown-to-mrkdwn
  library.
- Thread context comes from `client.conversations.replies` (needs `channels:history` +
  `groups:history` scopes); a top-level mention is single-turn.
- Bot scopes live in the Slack app config; the README's "Slack app setup" is the source of truth.

## Config & secrets

- Local: `.env` (gitignored) from `.env.example`. Never commit real tokens.
- Prod (homelab): secrets live at **`/opt/bumblebee/.env`** on the host, mounted into the runner —
  nothing flows through GitHub Actions secrets.
- Required vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` (+ optional `LOG_LEVEL`,
  `AZURE_OPENAI_API_VERSION`).

## Local dev

- `npm run dev` (tsx watch). On start expect `⚡️ Bumblebee running (socket mode)`.
- **Never run local dev while the homelab container is up** — two Socket Mode connections on the
  same app token make the bot reply twice.

## Workflow & deploy

- `main` is **branch-protected**: no direct commits/pushes (git hooks + GitHub rules enforce it).
  Branch → PR → `ci-gate` green → merge.
- **Conventional Commits** required (`commit-msg` hook). Hooks auto-enable via the `prepare` script.
- CI ([.github/workflows/ci.yml](../../../.github/workflows/ci.yml)): typecheck, build, prod audit,
  gitleaks → `ci-gate`. **Push to `main` deploys** on the `[self-hosted, homelab]` runner using
  `compose.prod.yaml` (build → roll → healthcheck; Socket Mode has no HTTP check, so it confirms the
  startup log line).
