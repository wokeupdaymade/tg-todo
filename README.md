# Telegram To-Do

A private, single-user to-do manager living in Telegram: a **Mini App** (full manager), a persistent **preview widget** in the chat, **creation widgets** spawned by typing a task, and **reminders** for timed tasks.

> **Widgets are currently blocked by Telegram** for ordinary bots (`INPUT_MEDIA_WIDGET_NOT_ALLOWED`, since 13 Nov 2026). The bot detects this and uses regular messages with buttons instead. It re-checks every 12 h and switches back by itself. See `WIDGETS` in `.env.example`. Implements `docs/spec-v2.md`; decisions taken during implementation are in `docs/decisions.md`.

## Stack

- **Node.js 22** (≥ 22.18) running TypeScript directly (native type stripping — no compile step for the server).
- **SQLite** via the built-in `node:sqlite` (no native dependencies). Append-only migrations, WAL, daily snapshots.
- **Bot API 10.4** through a small hand-written client (`src/telegram/api.ts`) — no library supports HTML widgets yet. Long polling.
- **Mini App**: Preact + esbuild, served by the same process. HTTPS terminated by **Caddy** (automatic Let's Encrypt).
- **Widgets**: hand-written HTML/JS in `src/widgets/src/`, minified at build time with a hard size gate (≤ 3800 B after zlib-9; Telegram's limit is 4096).

## Layout

```
src/
  main.ts            wiring, scheduler, shutdown
  time.ts parse.ts tasks.ts   shared with the Mini App (time zones, date/time parser, ordering)
  db.ts              schema, migrations, backups
  services/          tasks (store), reminders, preview, flows (chat creation), context helpers
  bot/router.ts      updates → commands / text / widget queries; whitelist
  http/              Mini App static files + JSON API, initData verification
  telegram/          Bot API client + long polling
  widgets/src/       preview.html, creation.html, reminder.html
webapp/src/          Mini App (Preact)
test/                unit + end-to-end tests against a fake Bot API
docs/                spec, decisions, Telegram widget reference snapshot
```

## Setup

1. **Bot**: create one with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Main Mini App** (required — the preview widget opens the app through `t.me/<bot>?startapp=…` links):
   BotFather → your bot → *Bot Settings* → *Configure Mini App* → enable it and set the URL to your `PUBLIC_URL`.
   (The bot sets its own "Open App" menu button at startup.)
3. **Your user id**: e.g. ask [@userinfobot](https://t.me/userinfobot). Put it in `ALLOWED_USER_IDS`.
4. **Server**: a machine with a public IP and a domain (A record → server). Ports 80 and 443 open.
5. Configure and start:
   ```bash
   cp .env.example .env    # fill in BOT_TOKEN, ALLOWED_USER_IDS, PUBLIC_URL, DOMAIN, DEFAULT_TZ
   docker compose up -d --build
   ```
6. In Telegram, send `/start` to the bot.

No public address? Run the `bot` service alone and expose port 8080 through a tunnel (e.g. Cloudflare Tunnel); set `PUBLIC_URL` to the tunnel's https URL.

### On Windows (PC or VPS), one click

1. Install **Node.js 24 LTS** or newer from nodejs.org (22.18+ works without a proxy).
2. Sign up at https://tuna.am and create an **API key** with tunnel access (it starts with `tak_`).
3. Double-click **`start.bat`**. On the first run it creates `.env` and opens it in Notepad: fill in `BOT_TOKEN`, `ALLOWED_USER_IDS`, `DEFAULT_TZ` and `TUNA_API_KEY` (and `TELEGRAM_PROXY` if Telegram needs a proxy), save, and double-click `start.bat` again.
4. It installs Tuna via winget, builds, opens the tunnel on your free permanent Tuna address (found automatically), starts the bot, and checks that the Mini App is reachable. Paste the address once in BotFather → *Configure Mini App*.
5. **Close the window to stop the bot.** The bot restarts by itself if it crashes; the tunnel reconnects by itself if it drops.

**Proxy:** `TELEGRAM_PROXY` (or `HTTP_PROXY`/`HTTPS_PROXY` set in `start.bat`) is used only for the bot's Telegram traffic. The tunnel never sees it and connects directly. This needs Node.js 24+.

Free Tuna addresses show a one-time warning page when the Mini App opens in a browser. `TUNNEL=cloudflared` or `TUNNEL=ngrok` in `.env` switch to those tunnels instead.

### Without Docker

```bash
npm ci
npm run build
cp .env.example .env    # then edit
node --env-file=.env --disable-warning=ExperimentalWarning src/main.ts
```
Put any HTTPS reverse proxy in front of port 8080.

## Using it

- **Add a task in chat**: send any text. The first line becomes the title; a creation widget asks for the date (Today / Tomorrow / Other Date → calendar) and then the time (No Specific Time / hour grid → 5-minute grid). You can also tap the reply-keyboard shortcuts or type: dates like `11.12`, `Dec 11`, `11 December 2027`; times like `14:30`, `9.45`, `1430`, `9:45 PM`. Everything is cleaned out of the chat once you save or cancel.
- **Preview**: the widget in the chat shows up to 3 tasks for today and 3 for the coming days; tap a circle to complete it (with Undo), tap a title to open it in the app.
- **Reminders**: timed tasks remind you at their time, every 5 minutes, up to 12 repeats. Done / Snooze 15 min / Dismiss.
- **Commands**: `/start` (re-send the preview), `/cancel` (cancel the task being created), `/settings` (show the time zone), `/settings Europe/Berlin` (change it).

## Operations

- Data: `./data/todo.sqlite` (WAL). Daily snapshots in `./data/backups/` (14 kept). To restore, stop the bot and copy a snapshot over `todo.sqlite` (delete `todo.sqlite-wal`/`-shm`).
- Upgrades: `git pull && docker compose up -d --build`. Migrations run automatically and never drop data; a build older than the database refuses to start rather than touching it. A changed preview layout is re-sent automatically.
- Health: `GET /healthz`.

## Development

```bash
npm install
npm test            # builds, then runs all tests (no network, fake Bot API)
npm run typecheck
```
