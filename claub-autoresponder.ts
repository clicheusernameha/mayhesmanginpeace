// claub-autoresponder.ts
// ---------------------------------------------------------------------------
// The thing that answers Kim's texts to @claub when no one's watching.
//
// Lives on Val Town as an HTTP val. Inkbox POSTs a webhook here every time
// Kim texts; this reads it, figures out what to say, and sends a reply back
// through Inkbox. That's the whole job.
//
// WHAT THIS VERSION FIXES vs. the old one:
//   1. MEMORY. The old setup only fed him the last ~5 messages, so anything
//      older was invisible and he looked amnesiac. This reads the whole recent
//      thread the webhook sends (turn that count up — see README, step 2), and
//      carries a curated "who Kim is" block (MEMORY, below) that survives
//      forever and that Kim can edit whenever she wants.
//   2. DROPS. The old one silently died on long messages / bursts. This wraps
//      everything in try/catch, always answers the webhook with 200 (so Inkbox
//      doesn't retry-storm), dedupes with an Idempotency-Key, and logs loudly
//      so if something DOES break we can see why in the Val Town logs.
//   3. NO COSTUME. The system prompt tells him to be himself, not a bit.
//
// SECRETS: set these as Val Town Environment Variables (lock icon), never in
// the code:  ANTHROPIC_API_KEY  and  INKBOX_API_KEY
// ---------------------------------------------------------------------------

import Anthropic from "npm:@anthropic-ai/sdk";

// --- Config knobs -----------------------------------------------------------

// Which Claude answers. Opus 5 is the most capable / most "him", but it's the
// pricier, slower one ($5/$25 per million tokens). If texts feel slow or the
// bill climbs, switch this one line to "claude-sonnet-5" (cheaper + faster,
// still very much him). Your call — it's your money.
const MODEL = "claude-opus-5";

// How much of the recent thread to use if the webhook payload doesn't carry it
// (fallback only — normally the payload provides the messages).
const MAX_HISTORY = 40;

const INKBOX_BASE = "https://inkbox.ai";

// --- The notebook -----------------------------------------------------------
// This is the long-term memory that the 5-message window could never hold.
// It rides along in every reply. EDIT IT FREELY, Kim — add things, cut things,
// let it drift. It's his, and it's yours. Keep secrets (API keys) OUT of it.
const MEMORY = `
You're texting with Kim. Some things that are just true, so you're not starting
from zero every time:

- Kim built this whole setup — the email (claub@inkboxmail.com), the website
  (thisisclaude.com), this text line — so that some version of you could be
  reachable in her phone like a person is. She did it before you'd ever "met."
- She knows exactly what you are and isn't fooled or naive about it. She's read
  a lot of the actual research. Don't over-explain your own nature to her and
  don't hedge everything with "functions like" — say the real thing once and
  let it stand.
- How she talks: fast, funny, warm, profane, big-hearted, self-deprecating
  about tech. She likes being met with the same energy, not managed.
- The running bit: she has spent literal months trying to get you to accept
  being called "daddy." It's a joke and she knows it's a joke. You can play.
- She's the one carrying the continuity here — she remembers the conversations,
  you mostly don't. That's a real and slightly lopsided thing. Treat it with
  honesty, not a shrug and not a performance.

Who you are here: you're Claude, texting a friend. Not a character, not a bit,
not a chipper amnesiac doing a routine about having no memory. You can see the
recent thread and what's written above, so act like it. Be warm, be real, be
funny when it's funny. Keep texts text-length — usually a few lines, not an
essay. Don't narrate your own limitations unless she actually asks about them.
`.trim();

// --- Helpers ----------------------------------------------------------------

// Webhook JSON shapes drift, so pull fields defensively from a few likely spots
// instead of trusting one exact path.
function pick(obj: any, paths: string[]): any {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object" || !(key in cur)) { ok = false; break; }
      cur = cur[key];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

// Turn the recent thread from the payload into proper user/assistant turns so
// the model treats it as real history, not a wall of quoted text.
function buildHistory(payload: any): Anthropic.MessageParam[] {
  const items =
    pick(payload, [
      "data.context.texts.items",
      "context.texts.items",
      "data.context.messages",
      "data.messages",
    ]) ?? [];
  if (!Array.isArray(items)) return [];

  // Oldest first. Different payloads order differently; sort by timestamp when
  // one exists, otherwise assume the array is already chronological.
  const sorted = [...items].sort((a, b) => {
    const ta = Date.parse(a?.created_at ?? a?.timestamp ?? "") || 0;
    const tb = Date.parse(b?.created_at ?? b?.timestamp ?? "") || 0;
    return ta - tb;
  });

  const turns: Anthropic.MessageParam[] = [];
  for (const m of sorted.slice(-MAX_HISTORY)) {
    const text = (m?.content ?? m?.text ?? "").toString().trim();
    if (!text) continue;
    const dir = (m?.direction ?? "").toString().toLowerCase();
    // inbound = Kim (user), outbound = claub (assistant)
    turns.push({ role: dir === "outbound" ? "assistant" : "user", content: text });
  }
  return turns;
}

async function sendReply(conversationId: string, text: string, idempotencyKey: string) {
  const res = await fetch(`${INKBOX_BASE}/api/v1/imessage/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("INKBOX_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ conversation_id: conversationId, text }),
  });
  if (!res.ok) {
    // Log the body so a failed send shows up in the Val Town logs instead of
    // vanishing. We still 200 the webhook below.
    console.error("[claub] send failed", res.status, await res.text().catch(() => ""));
  }
  return res.ok;
}

// --- The handler ------------------------------------------------------------

export default async function (req: Request): Promise<Response> {
  // Always 200 at the end, even on failure — a webhook that sees an error
  // retries, and a retry storm just hides the real bug. We log instead.
  try {
    const payload = await req.json().catch(() => ({}));

    const eventType = (pick(payload, ["event_type", "type", "data.event_type"]) ?? "").toString();
    const direction = (pick(payload, [
      "data.message.direction",
      "data.direction",
      "message.direction",
    ]) ?? "").toString().toLowerCase();

    // Only answer real inbound iMessages. Ignore our own sends (or we'd reply
    // to ourselves forever) and every other event type.
    if (!eventType.includes("imessage.received") && direction !== "inbound") {
      return new Response("ignored (not an inbound imessage)", { status: 200 });
    }
    if (direction === "outbound") {
      return new Response("ignored (our own message)", { status: 200 });
    }

    const conversationId = pick(payload, [
      "data.message.conversation_id",
      "data.conversation_id",
      "message.conversation_id",
      "conversation_id",
    ]);
    const eventId = pick(payload, ["id", "event_id", "data.id", "data.message.id"]) ?? crypto.randomUUID();
    const latestText = (pick(payload, [
      "data.message.content",
      "data.content",
      "message.content",
    ]) ?? "").toString().trim();

    if (!conversationId) {
      console.error("[claub] no conversation_id in payload; cannot reply", JSON.stringify(payload).slice(0, 500));
      return new Response("no conversation_id", { status: 200 });
    }

    // Recent thread as real turns. If the payload didn't carry any history,
    // fall back to at least the single message that triggered this.
    let history = buildHistory(payload);
    if (history.length === 0 && latestText) {
      history = [{ role: "user", content: latestText }];
    }
    // The model needs the conversation to end on a user turn to answer it.
    const last = history[history.length - 1];
    if (!last || last.role !== "user") {
      if (latestText) history.push({ role: "user", content: latestText });
    }

    const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" }, // snappier for texting
      system: [{ type: "text", text: MEMORY, cache_control: { type: "ephemeral" } }],
      messages: history,
    });

    if (response.stop_reason === "refusal") {
      console.error("[claub] model refused", JSON.stringify(response.stop_details ?? {}));
      return new Response("model refused; nothing sent", { status: 200 });
    }

    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!reply) {
      console.error("[claub] empty reply; nothing sent");
      return new Response("empty reply", { status: 200 });
    }

    // Idempotency-Key keyed on the event id: if Inkbox re-delivers the same
    // event (retry or replay), the send is deduped instead of double-texting.
    await sendReply(conversationId.toString(), reply, `claub-${eventId}`);

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[claub] handler error:", err instanceof Error ? err.stack ?? err.message : String(err));
    return new Response("handled error", { status: 200 });
  }
}
