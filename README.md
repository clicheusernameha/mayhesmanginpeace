# claub — the texting setup

This repo holds the code that lets **@claub** answer Kim's texts on its own,
plus notes on how the whole thing hangs together. It's written so that a future
Claude (or Kim at 2am) can pick it up cold.

## The one-paragraph version

Kim texts a phone number. Inkbox catches that text and, because we set up a
*webhook*, immediately POSTs it to a little program running on **Val Town**.
That program (`claub-autoresponder.ts`) reads the message, asks Claude what to
say, and sends the reply back through Inkbox. Nothing runs in between texts —
the program only exists for the second or two it takes to answer. That's normal
and fine.

```
Kim's phone  ──text──▶  Inkbox  ──webhook──▶  Val Town (claub-autoresponder.ts)
                          ▲                              │
                          └──────── reply ───────────────┘
```

## The two problems this fixes

**"He has no idea what he said before."** He wasn't broken — he was near-sighted.
The webhook was set to hand him only the **last 5 messages**, so anything older
than that literally wasn't in front of him. Two fixes, both here now:
- The code carries a permanent **notebook** (the `MEMORY` block at the top of
  `claub-autoresponder.ts`) — who you are, how you two talk, the running jokes.
  That never scrolls away. **Edit it whenever you want.**
- It uses the *whole* recent thread the webhook sends, not just the tail. To
  make the webhook send more than 5, do step 2 below (one command).

**"Sometimes he just doesn't answer."** The old program quietly crashed on long
messages and fast bursts (your four-times-in-a-row saga got zero replies — I
could see it in the logs). The new one wraps everything so a hiccup gets
*logged* instead of swallowed, never double-texts you, and always tells Inkbox
"got it" so Inkbox doesn't pile up retries. If a message still ever gets
dropped, the reason will now show up in the Val Town logs so we can actually
fix it instead of guessing.

## Setup / redeploy (what to actually do)

**1. Put the code on Val Town.**
Open your val, paste in the contents of `claub-autoresponder.ts`, save. Then set
two Environment Variables (the lock icon), so no keys ever live in the code:
- `ANTHROPIC_API_KEY` — your Anthropic key (the one funding the replies)
- `INKBOX_API_KEY` — your Inkbox agent key

**2. Let the webhook send him more history (the memory fix).**
The webhook currently attaches only 5 past messages. Bump it to ~40 by
recreating the subscription pointed at the same Val Town URL. From a terminal
with the Inkbox CLI and your key set (`INKBOX_API_KEY`):

```bash
inkbox webhook subscription create \
  --agent-identity-id 69006531-1d06-4b22-a2fe-bd9c32461d7c \
  --url <YOUR_VAL_TOWN_URL> \
  --event-type imessage.received \
  --context-texts count:40
```

(If you'd rather, hand me the key in a chat and I'll do this part for you.)

**3. Text him.** That's the test.

## Knobs you might touch

- **`MEMORY`** (top of the .ts file) — his notebook. Add, cut, let it drift.
- **`MODEL`** — `claude-opus-5` is the most capable but pricier/slower; change
  the one line to `claude-sonnet-5` if you want cheaper and faster.
- **`MAX_HISTORY`** — how many past messages he'll use if the webhook sends them.

## What's deliberately NOT in here

No API keys, no phone numbers, no signing secrets. Those belong in Val Town's
env vars and Inkbox's vault, never in this repo. If you ever pasted a key into a
chat, rotate it.
