# Implementation decisions (v1)

Decisions taken while building v1, where the spec was open, contradictory, or silent. The owner delegated these; revisit any of them freely.

## Resolved open items / contradictions
- **One creation flow at a time** (§6.1). The spec routes all typed text to an open flow, so a second flow could never start; the "reply to an older flow's widget" rule was therefore dropped. To add another task, save or cancel the current one (or wait for the 6 h auto-cancel).
- **Repeated bad input**: every unparseable message is deleted and re-prompted (the previous hint is replaced). The flow is never cancelled and the text never becomes a title.
- **Last reminder after 12 repeats** stays in the chat (it is still an active reminder) and is deleted automatically just before the 48 h deletion limit, or immediately when the task is completed, edited, deleted, snoozed or dismissed.
- **Pinning the preview: off by default** (`PIN_PREVIEW=true` turns it on). Each pin creates a "pinned a message" service message that the bot does not receive in updates, so it can't be deleted reliably; with ~one pin every 47 h that would leave clutter. Unpinned, the preview is still the newest persistent message near the bottom.
- **Time zone**: `DEFAULT_TZ` at first contact, changed with `/settings <IANA name | UTC±H>`. Changing it re-arms all reminders.
- **UI language** English; times displayed 24 h; AM/PM accepted as typed input. Calendar weeks start on Monday.

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
- Bot API 10.4 widgets were verified against the live docs (snapshot in `docs/telegram-widget-reference.txt`). Not yet verified on a real Telegram client: **first real-device test pending** (needs the bot token and a deployed HTTPS URL).
