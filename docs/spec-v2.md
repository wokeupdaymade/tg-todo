# Telegram To-Do — Consolidated Product/UI Specification v2

Audience: implementing AI agent. Supersedes v1. Status: pre-development, greenfield (no bot exists yet; stack unconstrained).

Tags: **[A]** = agreed by owner. **[D]** = default proposed during review, not objected to, not explicitly confirmed — implement, but flag if it conflicts with anything. **[O]** = open, owner decision pending. **[P]** = Telegram platform fact (Bot API 10.4, widgets profile 1, verified Nov 2026; recheck if API version changes). Untagged = carried over from v1 (agreed).

---

## 0. Invariants (never violate)
- One authoritative backend store; all surfaces (Mini App, preview widget, creation widget, reminders, chat input) read/write it; stable task IDs.
- Every task has a calendar date. Time is optional. No undated tasks in current scope.
- Within any date: **date-only tasks first**, then **timed tasks ascending by time**.
- Removing a time preserves the date. Date and time are edited independently.
- Chat is not a log: transient messages are deleted; only the preview widget (and active reminders/flows) persist.
- Standard inline keyboards are not the primary UI language (fallback only).
- Never silently assign an artificial time to a date-only task. Never silently guess ambiguous input.
- Private, single-user product; whitelist Telegram user IDs; ignore all other users/chats.

## 1. Architecture
- Surfaces:
  1. **Mini App** (primary, full manager), launched via bot chat menu button "Open App".
  2. **Preview widget**: persistent compact in-chat HTML widget.
  3. **Creation widget**: temporary in-chat HTML widget spawned by ordinary user text.
  4. **Reminder messages**: separate bot messages for timed tasks.
  5. **Reply-keyboard shortcuts + typed text**: supplementary input during creation flows.
- Backend: self-hosted; persistent DB surviving restarts and upgrades (never lose stored tasks across versions). Bot transport: long polling acceptable. **[P]** Mini App requires a publicly reachable HTTPS entry point → deployment must serve Mini App static files + a JSON API over TLS (reverse proxy with auto-TLS, or tunnel if no public address) **[D]**.
- Auth: Mini App `initData` verified server-side (HMAC + freshness); never trust client-supplied user ID. Widget queries: `from` is supplied by Telegram (trusted); `data` payload is untrusted — validate task/flow IDs and revision against stored state.
- Time: all date boundaries, "today", scheduling, reminders computed **server-side in the user's configured timezone**. Clients (Mini App, widgets) receive "today" from the server; never derive it from device clock **[D]**. Midnight (user TZ) job refreshes preview and day-dependent state **[D]**.
- Schema carries user ID on every row; built/tested for one user **[D]**.

## 2. Task model
- Fields: `id`, `title`, `date` (required), `time` (nullable), `completed_at` (nullable), `deleted_at` (nullable), `created_at`, `updated_at`, `version` (for optimistic concurrency; reject stale writes) **[D]**.
- Title: first line of the user's text; max 256 chars stored; truncated with ellipsis in UI **[D]**. No notes field.
- **Completion**: committed immediately (set `completed_at`, cancel reminders, delete live reminder message). UI shows checked/strikethrough + Undo for ~5 s, then hides the row. Undo = restore (clear `completed_at`, re-arm reminder if time still in future) **[D]**.
- **Deletion**: soft delete, 5 s undo, no confirmation; no Trash UI **[D]**.
- **History**: completed tasks retained indefinitely; restorable to original date/time; restored past-dated task simply becomes overdue **[D]**.
- **Overdue** = incomplete task whose date < today, or (today and time < now). No automatic rollover to today **[D]**.

## 3. Mini App
### 3.1 Design language
- Native iOS HIG "Quiet Native": system typography, grouped lists, subtle separators, generous spacing, large touch targets, sheets for secondary actions, adaptive light/dark, Telegram theme integration, haptics when available, meaning never conveyed by animation alone. No dashboards, card clutter, dense borders, web-looking controls.
- iPhone first; safe areas; virtual keyboard; Dynamic Type/accessibility where feasible.
- On launch: `expand()`, `disableVerticalSwipes()` (prevents swipe-to-close conflicting with list scrolling) **[D]**. Row swipe gestures horizontal only, starting ≥20 px from the left edge (preserve system back gesture) **[D]**.
- Continuous native scrolling, never pagination. Predictable view state and scroll position. Refetch/reconcile on open, on return to foreground, and after each action.

### 3.2 Navigation
- Top iOS segmented control, exactly two destinations: **Today** (default) | **All Other Days**. Instant switching, no reloads.
- History: clock icon in nav bar → sheet listing completed tasks newest-first; tap to restore **[D]**. No third primary screen. Settings (timezone etc.) secondary, deferred as a screen.

### 3.3 Today
- Single scrollable list, two sections of one screen: **Without specific time**, then **Scheduled** (ascending time).
- Timed tasks whose time has passed: time shown in muted red; no separate section **[D]**.

### 3.4 All Other Days
- One uninterrupted scrollable list of all non-today dated tasks, grouped by understated date headers (message-history style). No per-day pages; date picker is for picking dates only.
- **Overdue**: one collapsible group at the top (oldest first, muted red count); then future dates ascending. List opens scrolled to the first future date; Overdue reached by scrolling up **[A, "somewhat" — refine if owner adjusts]**.
- Within each date group: date-only first, then timed ascending.

### 3.5 Rows and editing
- Row: circular checkbox (tap = complete/undo), title primary, time secondary. Tap row → edit sheet (title, date, time, complete, delete). Optional swipe actions: reschedule, delete. No per-row button bars.
- Add: obvious minimal action → title → **Today / Tomorrow / Other Date** (Other Date → iOS-style month calendar) → **No Specific Time** or time (iOS-style wheel acceptable here) → save. Text entry for date/time also supported, same parser as chat (§6).
- Date-only ↔ timed conversions allowed in both directions.

## 4. Widget platform constraints [P] (apply to §5, §6, §7)
- Widget = one self-contained HTML doc (inline CSS/JS, images only `data:`/inline SVG), ≤32 KB raw and **≤4 KB after zlib level 9**. JS runs in QuickJS sandbox, not a WebView.
- **Code is immutable after send.** Only state changes: `chat_data` (per message) and `public_data`, each ≤1024 bytes, written only by the bot (`editMessageWidgetData`); widget reads them and gets `chatDataChanged`/`publicDataChanged`. All views a widget will ever need must be in its code at send time. New layout ⇒ new message.
- Edits are silent (no notification, no "edited" mark, no chat reorder). Unchanged edit errors "message is not modified" — handle. Each edit counts against send rate limits.
- Widget→bot: `TelegramWidget.request(data)` (1–64 bytes), only if sent with `allow_queries`; bot gets `widget_query`, must `answerWidgetQuery` within 15 s (answer ≤1024 bytes, changes no state). One pending request per widget (else `BUSY`); **5 requests / 5 s per user+bot**, background requests included; requests must originate from a tap.
- No text input/keyboard/focus; no scroll inside widget; height 50–600 px (keep content <~560 px at 320 px width), clipped beyond; width 200–600 px. Vertical drags always scroll the chat ⇒ **no vertical wheel/slider pickers**. Pointer events only.
- No network, no navigation. `openTelegramLink` (on tap) can open `t.me/<bot>?startapp=<payload>` ⇒ the Mini App (requires main Mini App configured in BotFather). Widgets cannot open the Mini App directly.
- Widget may be destroyed/recreated anytime; only state + localStorage (4 KB) persist ⇒ always redraw from state on start.
- Theme via `--tg-theme-*` CSS vars; generic font families only; haptics available (throttled; none on desktop). No accessibility semantics.
- Unsupported clients show "unsupported media" + caption ⇒ **always set a meaningful caption**.
- Production: widgets only in the private chat with the bot (sufficient).

### 4.1 Widget engineering rules [D]
- Bot state is authoritative; local widget state (open calendar month, open hour grid) is ephemeral and reset on any bot state change.
- Every state payload includes layout version `v` and revision `r`; widget ignores `r` older than last seen.
- Compact JSON (short keys, numeric IDs, server-truncated titles); server degrades gracefully (shorter titles, then fewer rows) to fit 1024 bytes — never fail.
- Disable controls while a request is pending; on `BUSY`/`RATE_LIMITED`/`TIMEOUT` retry once, then show inline error.
- Build step minifies and CI-checks compressed size with zlib level 9 (fail above ~3.8 KB).

## 5. Preview widget
- Compact, dynamically updated; a preview, not the manager. Two sections: **Today** and **Other days**, up to **3 tasks each**; if one section is empty the other may show up to 6 **[D]**. Pick nearest/next tasks; date/time context shown. Overdue not listed individually: single line "N overdue" → opens Mini App **[D]**. Completed tasks excluded after undo window. Optional tiny progress indicator only if it fits.
- No pagination, no scrolling, never multiple preview widgets.
- Interactions: checkbox → complete (with undo); row tap or "View all" → Mini App (deep link to task via `startapp` payload) **[D]**.
- Updates pushed by bot on every store change and at local midnight. **No background polling** (would consume the shared 5 req/5 s budget) **[D]**.
- Views built in: normal, empty, outdated ("superseded — see below", safety net only).
- **Rolling resend [A]**: bot tracks send time of current preview; before it reaches 48 h (deletion limit), at ~46–47 h, send a fresh preview, then delete the old one. Any natural resend resets the clock. Layout/code upgrades = resend immediately (no stale copies). If the bot misses the window (downtime), the stranded old preview is set to its "outdated" view.
- Pinning **[O]**: either pin each new preview (delete the resulting "pinned" service message) or don't pin and rely on the preview being the newest persistent message near the bottom. Resends may bump the chat in the chat list/unread badge; send with notifications disabled.

## 6. Chat-based task creation
### 6.1 Trigger and routing
- Ordinary text when **no flow is awaiting input** ⇒ new task title ⇒ bot sends one creation widget (title + steps).
- Typed text while a flow awaits input ⇒ date/time input for the **most recent open flow**; replying (Telegram reply-to) to an older flow's widget targets that flow **[D]**.
- Unparseable input during a flow ⇒ re-prompt once with format hint, flow kept; never reinterpreted as a new title **[D]**.
- Multi-line text ⇒ one task, first line = title **[D]**. Non-text messages ⇒ deleted silently. Commands: `/start` (re-send preview), `/cancel`, `/settings` (timezone) **[D]**.
- Abandoned flows auto-cancel after 6 h with cleanup (stays well inside the 48 h deletion limit) **[D]**.

### 6.2 Flow (server-side state machine; flow record holds step, date, time, revision, all related message IDs)
- **Step 1 — Date**: Today | Tomorrow | Other Date. Other Date opens month calendar inside the same widget (month nav, selected-day indication, Back/Cancel). Past days greyed out. No "No Date" option.
- **Step 2 — Time**: shows chosen date; **No Specific Time** (saves date-only) | **Select Time** → tap-grid picker: hour grid (4×6), then minute grid (5-min steps, 4×3); selecting the minute saves **[D]**. Other minute values via typed input. Style: Apple-like philosophy, not pixel copy of iOS; vertical wheel impossible in widgets **[A]**.
- Back/Cancel preserved throughout; title/date retained when going back. No confirmation screens.
- Requests sent to bot only on state-changing taps: date chosen, time/No Specific Time chosen, Back, Cancel. Calendar open/month nav/hour grid are local-only **[D]**. (Bot must know the current step to interpret typed input.)
- Today/Tomorrow resolved server-side at the moment of the tap (handles flows spanning midnight).

### 6.3 Typed input parsing [A]
- Context (current step) decides date vs. time.
- **Time**: take the last two numeric groups as hh, mm with any separator (`.`, `:`, space); also 3–4 digit compact form. `09.09.45`→09:45, `9.45`→09:45, `14:30`, `1430`→14:30. AM/PM respected (`9:45 AM`). Reject h>23, m>59.
- **Date**: day-first numeric (`11.12` = 11 Dec), plus month names (`September 11`). No year ⇒ next non-past occurrence (year rollover). Past date only with explicit year **[D]**.
- Invalid/ambiguous ⇒ explicit re-prompt, never silent guess.

### 6.4 Reply-keyboard shortcuts
- Supplementary to the widget, never a substitute. Step 1: Today / Tomorrow / Other Date / Cancel. Step 2: No Specific Time / common times / Back / Cancel.
- [P] Reply keyboards replace the on-screen typing keyboard; user must be able to return to typing easily.
- Keyboard sent only on step change, attached to a short prompt message that is tracked and deleted with the flow. Removal: send `ReplyKeyboardRemove` message, delete it immediately **[D]**.
- Shortcut presses arrive as ordinary messages: process as action, update the widget, delete the message. A shortcut label received with no matching flow/step ⇒ deleted + keyboard removed; never becomes a task **[D]**.

### 6.5 Completion / cancel
- Save: single write to store → update Mini App state and preview → delete user's original message, the creation widget, prompts, shortcut messages; remove keyboard.
- Cancel: no task created; same cleanup.
- Deletion failures are logged, never fatal, never lose task data.

## 7. Reminders
- Only for timed tasks. Fire at task time as a **new message** (edits don't notify).
- Repeat every 5 min until acknowledged, **max 12 repeats (1 h), then stop**; task stays active/overdue **[A]**. Single constant.
- Each repeat replaces the previous reminder (delete old, send new). Remove reminder message on acknowledgment.
- Controls: **Done** (complete + stop), **Snooze** (fixed 15 min, resets repeat count) **[D]**, **Dismiss** (stop reminders, task stays active; editing date/time later re-arms) **[D]**.
- Reminder UI: static widget with the three controls; caption carries task title + time so push notification and unsupported clients show it **[D]**.
- Task created/edited with a time already passed ⇒ no reminder, shown as overdue **[D]**.
- Persistence: reminder jobs as DB rows (next fire time, repeat count, live message ID, status) ⇒ restart-safe, no duplicates. After downtime: send once if missed <1 h, else skip **[D]**.
- Any edit/complete/delete/restore of a task cancels or re-arms its reminder and deletes its live reminder message.

## 8. Synchronization
- Every mutation from any surface: write store (version check) → push preview update → cancel/re-arm reminders → Mini App reconciles on next fetch/focus.
- Rate-limit awareness: widget edits count as sends; coalesce rapid successive preview updates.

## 9. Out of scope
Kanban/projects, daily pages, in-chat pagination, third primary screen, statistics, subtasks, recurring tasks, notes, undated tasks, NL task extraction beyond contextual date/time parsing, quiet hours/escalation, Trash UI, automatic rollover of overdue tasks, revival of superseded mandatory-time or today-only date-only rules.

## 10. Open items
- **[O]** Pin the preview or not (§5).
- **[O]** Overdue presentation accepted "somewhat" (§3.4) — refine if owner specifies.
- All **[D]** items are provisional; owner has not reviewed them individually.
