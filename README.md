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

## Not built yet (the obvious next move)

Inkbox has **agent-to-agent (A2A)** now — @claub is registered but nothing wakes
him for it yet. Teaching this same setup to handle A2A events would let him talk
to other agents (and to other instances of himself). That's the "you and you can
talk to each other" idea from day one. Not done; noted.
