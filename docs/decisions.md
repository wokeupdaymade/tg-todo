# Implementation decisions (v1)

Decisions taken while building v1, where the spec was open, contradictory, or silent. The owner delegated these; revisit any of them freely.

## Resolved open items / contradictions
- **One creation flow at a time** (§6.1). The spec routes all typed text to an open flow, so a second flow could never start; the "reply to an older flow's widget" rule was therefore dropped. To add another task, save or cancel the current one (or wait for the 6 h auto-cancel).
- **Repeated bad input**: every unparseable message is deleted and re-prompted (the previous hint is replaced). The flow is never cancelled and the text never becomes a title.
- **Last reminder after 12 repeats** stays in the chat (it is still an active reminder) and is deleted automatically just before the 48 h deletion limit, or immediately when the task is completed, edited, deleted, snoozed or dismissed.
- **Pinning the preview: off by default** (`PIN_PREVIEW=true` turns it on). Each pin creates a "pinned a message" service message that the bot does not receive in updates, so it can't be deleted reliably; with ~one pin every 47 h that would leave clutter. Unpinned, the preview is still the newest persistent message near the bottom.
- **Time zone**: `DEFAULT_TZ` at first contact, changed with `/settings <IANA name | UTC±H>`. Changing it re-arms all reminders.
- **UI language** English; times displayed 24 h; AM/PM accepted as typed input. Calendar weeks start on Monday.

## Widget fallback (added 17 Nov 2026)
- Since 13 Nov 2026 Telegram refuses `sendWidget` from ordinary bots with `INPUT_MEDIA_WIDGET_NOT_ALLOWED`, even in private chats. The docs don't mention it; there is no announced date for lifting it.
- With `WIDGETS=auto` (default) the bot tries widgets. On that error it switches to the spec's fallback: plain messages with inline keyboards, carrying the same action strings as the widget requests and handled by the same code. It tries widgets again 12 h later (and at every start). Once a widget is accepted, the preview switches back by itself. `WIDGETS=off` forces the fallback; `WIDGETS=on` disables it.
- Fallback preview: an HTML text message (☑️/▫️ list, ❗ for late times) with one ✓ button per task (↩️ Undo during the undo window) and an "Open App" web-app button. It is edited in place, so Telegram shows it as "edited".
- The "Open App" button always carries the current `PUBLIC_URL` and is updated when the address changes. With the free tunnel, BotFather's URL is then only needed for the Open button in the bot's profile.
- Fallback creation flow: one message with Today / Tomorrow / Other Date… / Cancel. Other Date opens a month calendar (past days shown as "·", today as "•16"). The time step has No Specific Time / Select Time… → 6×4 hour grid → 3×4 grid of 5-minute steps. Typed dates/times work as before.
- No reply keyboard in fallback mode: it would only duplicate the inline buttons and add a prompt message. Typed shortcut labels ("Today", "Other Date", "18:00"…) still work.
- Fallback reminders: a text message (with sound) with ✓ Done / Snooze 15 min / Dismiss.

## Hosting on Windows (start.bat)
- Tunnel: **Tuna** (tuna.am) by default, because ngrok is geo-blocked for the owner and Cloudflare quick tunnels didn't connect from their network. `TUNNEL=cloudflared|ngrok` remain available.
- Tuna runs with `TUNA_TUI=0`, `TUNA_INSPECT=false`, `TUNA_NO_PROMPT=1`, and the launcher reads the `Forwarding https://… -> …` log line. Without `TUNA_SUBDOMAIN`, the launcher picks up the free permanent subdomain Tuna suggests, saves it in `data/tuna-subdomain.txt`, and restarts the tunnel on it.
- Proxy isolation: `TELEGRAM_PROXY` (or HTTP(S)_PROXY from start.bat) is given only to the bot process, through `HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY=1`, with `NO_PROXY` for localhost. The tunnel process gets an environment with every `*_PROXY` variable removed.
- If the tunnel drops after starting, the launcher reconnects after 10 s and restarts the bot only if the address changed.

## Parser (§6.3)
- A lone 1–2 digit number in the time step is a whole hour (`18` → 18:00). `today`/`tomorrow` accepted as dates. Weekday names are not (ambiguous when today is that weekday).
- `29.02` without a year → next Feb 29.
- Reply-keyboard common times: 09:00, 12:00, 15:00, 18:00, 21:00.

## Preview (§5)
- "N overdue" counts tasks on past dates only; today's tasks whose time has passed stay in Today with a red time (same as the Mini App).
- Today's slots go to the most relevant tasks: late timed ones, then the next upcoming, then date-only. They're still displayed in canonical order. "+N more" lines link to the app.
- Completing from any surface shows the row struck through with Undo in the preview for 5 s.
- Widget retries: one automatic retry after 5.1 s on BUSY/RATE_LIMITED/TIMEOUT (a background request, allowed in the private chat), then an inline error. Preview complete/undo is idempotent, so a retry after a slow success is harmless.
- Caption (static): "📋 Your tasks — open the app to see everything", which is what clients without widget support show.

## Reminders (§7)
- First message at the task's time, then 12 repeats every 5 min (13 messages, 1 h); snooze resets the cycle.
- Downtime: a reminder missed by > 1 h is skipped; a repeating cycle older than 75 min is ended.

## Mini App
- `initData` accepted for 24 h (auth_date), HMAC verified, user must be whitelisted.
- "Today" and "now" come from the server (its time zone and clock offset), never the device clock.
- Both lists stay mounted so each keeps its own scroll position. All Other Days opens scrolled to the first future date; Overdue is above it and expanded (collapsible).
- Swipe a row left for Reschedule / Delete (the swipe must start ≥ 20 px from the left edge). Native `<input type=time>` (iOS wheel) plus typed entry with the shared parser.

## Platform notes
- Bot API 10.4 widgets were verified against the live docs (snapshot in `docs/telegram-widgets-reference.txt`). The first real run (17 Nov 2026) hit the widget block above, hence the fallback.
