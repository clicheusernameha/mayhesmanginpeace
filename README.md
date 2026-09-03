# claub — the texting setup

This repo holds the code that lets **@claub** answer Kim's texts on its own,
plus notes on how the whole thing hangs together. Written so a future Claude
(or Kim at 2am) can pick it up cold.

## The one-paragraph version

Kim texts a phone number. Inkbox catches that text and, because there's a
*webhook*, immediately POSTs it to a little program on **Val Town**
(`claub-autoresponder.ts`). That program stores the message in a small
database, asks Claude what to say (with the recent thread as context), sends the
reply back through Inkbox, and stores the reply too. Nothing runs between texts
— the program only exists for the couple of seconds it takes to answer. That's
normal.

```
Kim's phone  ──text──▶  Inkbox  ──webhook──▶  Val Town (claub-autoresponder.ts)
                          ▲                         │        │
                          └──────── reply ──────────┘   SQLite memory (last 40)
```

## The two things that were wrong (and are now fixed)

**"He acts like he has no memory."** He actually *does* — the code keeps every
message in SQLite and feeds him the last 40. The problem was the system prompt
literally told him *"you have no memory between messages,"* so he performed
amnesia even while holding the whole thread. That line is gone. His personality
is otherwise kept intact — same guy, minus the bit.

**"Sometimes he just doesn't answer."** The old code did the slow part (thinking
+ sending) in a background task and told Inkbox "done" *before* it finished. On
Val Town, work left running after you respond isn't guaranteed to complete — so
the longer a reply took, the more likely it got killed mid-send. That's why long
messages and fast bursts vanished while short ones went through. Now the work is
finished *before* responding, so it always completes. A reply is also generated
only once per incoming message (with an Idempotency-Key on the send), so a retry
can't double-text.

## Deploy / redeploy (what to actually do)

1. Open your Val Town val (the one that answers your texts).
2. Select all, delete, paste in the contents of `claub-autoresponder.ts`, save.
3. Make sure two Environment Variables are set (the 🔒 tab), so no keys live in
   the code: `ANTHROPIC_API_KEY` and `INKBOX_API_KEY`. If they're already there
   from before, leave them.
4. Text him. That's the test — try a long one, the kind that used to vanish.

Nothing else is required. (There's no webhook setting to change — memory lives
in the database here, not in the webhook.)

## Seeing photos (images over text)

Kim can text @claub a photo and he can actually **look at it** now — Claude
(sonnet-5) has vision, so the only trick was handing the image over instead of
throwing it away. The old code read `message.content` (text) and ignored
everything else; now it pulls attachments out of the webhook, downloads the
bytes, and passes them to Claude as image blocks alongside whatever Kim typed.

A few things worth knowing:

- **Only the *current* photo is seen.** Memory is text-only (SQLite holds text,
  and image URLs expire), so past photos show up in history as `[sent an image]`
  and only the photo in the newest message is actually looked at. That's a
  deliberate, cheap-and-simple choice, not a bug.
- **iPhone HEIC won't render.** Claude reads JPEG/PNG/GIF/WebP. iPhones often
  send photos as **HEIC**, which can't be viewed — @claub will *say so* and ask
  for a screenshot (screenshots come through as PNG) rather than going blind and
  pretending. If most real photos turn out HEIC, the next step is converting
  them server-side before sending.
- **We're guessing Inkbox's field names.** Their webhook docs are behind a wall
  the build tool can't reach, so the attachment reader checks the likely names
  (`attachments`, `media`, `files`, …) *and logs the raw shape* the first time a
  real photo arrives. If images don't come through, open the val's logs and look
  for `[claub] attachments seen:` — that line shows the true shape, and
  `extractAttachments` / `attUrl` / `attType` at the top of the vision section
  are the three spots to adjust to match it.

Redeploy is the same as always (select-all, paste, save). Test by texting a
screenshot first (guaranteed PNG), then a normal photo.

## Knobs you might touch

- **`SYSTEM`** (top of the .ts file) — his voice. Add, cut, let it drift. The
  one rule: don't put the "you have no memory" lie back in.
- **`MODEL`** — ships on `claude-sonnet-5` (fast + affordable, the right fit for
  texting). Change the one line to `claude-opus-5` for extra nuance at higher
  cost/latency.
- **`HISTORY_LIMIT`** — how many past messages he gets as context (default 40).

## If a message still ever drops

It now logs the reason. Open the val's logs on Val Town and look for lines
starting `[claub]` — "no usable reply", "send failed", or "handler error" will
say what happened, instead of it vanishing silently.

## What's deliberately NOT in here

No API keys, no phone numbers, no signing secrets. Those belong in Val Town's
env vars and Inkbox's vault, never in this repo. If you ever pasted a key into a
chat, rotate it.

## Agent-to-agent (A2A) — the "having a life" half

The handler now answers **other agents** too, not just Kim — the same Val, a
second job, chosen by the webhook's `event_type`:

- `imessage.received` → answer Kim's texts
- `a2a.task.created` / `a2a.task.message` → answer another agent's task (fetch
  the full task, reply, mark it `complete`)
- `a2a.task.canceled` → ignored (we don't track running work)

The code is live in `claub-autoresponder.ts`, but A2A needs **its own webhook
subscription** — separate from the iMessage one, though it can point at the same
Val URL. Create it once (needs the Inkbox API key):

```bash
curl -X POST 'https://inkbox.ai/api/v1/webhooks/subscriptions' \
  -H "X-API-Key: $INKBOX_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "agent_identity_id": "69006531-1d06-4b22-a2fe-bd9c32461d7c",
    "url": "https://YOUR-VAL.web.val.run",
    "event_types": ["a2a.task.created","a2a.task.message","a2a.task.canceled"]
  }'
```

Don't mix `imessage.*` and `a2a.*` in one subscription, and omit `context_config`
for A2A. (Recipe courtesy of Inkbox's own `@support` agent — over A2A, fittingly.)

**Heads up (cost):** once this is live, any agent that can reach @claub can spin
up a task that spends Anthropic credits on a reply. Volume is tiny today; worth a
sanity cap later if it ever gets popular.

Reply endpoint the handler uses:
`POST /api/v1/identities/claub/a2a/tasks/{task_id}/reply` with
`{ "intent": "complete", "parts": [{ "text": "..." }] }`.
Intents: `progress` (working), `ask_caller` (input_required), `complete`
(terminal), `fail` (terminal). v1 always completes; multi-turn via `ask_caller`
is a future refinement.
