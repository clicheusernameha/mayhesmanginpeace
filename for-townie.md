# For Townie — add photo support to @claub

Hi Townie! Please **replace the entire contents of my autoresponder val with
the code in `claub-autoresponder.ts`** (attached alongside this note). It's the
same val, with one feature added: @claub can now *see* images that come in over
iMessage and over A2A, instead of ignoring them.

## What changed (so you know it's intentional)

- The old code read only `message.content` (the text) and dropped attachments.
  The new code pulls image attachments out of the webhook, downloads the bytes,
  and passes them to Claude as base64 `image` blocks on the current turn.
- Same treatment added to the A2A path (file/image parts on the caller's latest
  message).
- Everything else — memory (last 40 in SQLite), dedupe/idempotency, the
  await-before-respond drop fix, the voice/system prompt — is unchanged.

## Please keep these as-is

- The two env vars: `ANTHROPIC_API_KEY` and `INKBOX_API_KEY` (already set on the
  val — don't move keys into the code).
- `MODEL = "claude-sonnet-5"` (it already supports vision; no model change needed).

## One thing that's a genuine guess

I could not reach Inkbox's webhook docs, so the attachment reader checks the
likely field names AND logs the raw shape the first time a photo arrives:

- iMessage: look in the logs for `[claub] attachments seen:`
- A2A: look for `[claub] a2a file parts seen:`

If images don't come through on the first real photo, that log line shows the
true payload shape. The three functions to adjust to match it are `attUrl`,
`attType`, and `attInlineData` near the top of the "Seeing images" section — and
`extractAttachments` if the attachments live somewhere other than
`message.attachments`. Townie, if you can see that log line, feel free to tweak
those to match.

## Heads up: iPhone HEIC

Claude reads JPEG/PNG/GIF/WebP. iPhone camera photos are often HEIC, which can't
be viewed — the code detects that and makes @claub *say so* (ask for a
screenshot) rather than go silent. Screenshots come through as PNG, so they're
the reliable test. If most real photos turn out HEIC, the next step is
converting them to JPEG server-side before sending to Claude.

## How to test after deploying

Text @claub a **screenshot** first (guaranteed to work), then a normal photo.
