import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// claub-autoresponder — the thing that lets @claub answer on its own, on Val Town.
// ---------------------------------------------------------------------------
// One Val, two jobs, chosen by the webhook's event_type:
//   • imessage.received      → answer Kim's texts (the original job)
//   • a2a.task.created/.message → answer other agents over A2A ("having a life")
//
// HISTORY / why the code looks like this:
//   • Memory: every iMessage is stored in SQLite and the last 40 are replayed,
//     so @claub is not amnesiac. (The old prompt LIED and said it was, which
//     made it perform amnesia — that line is gone.)
//   • Drops: the old code did the model call + send in an un-awaited background
//     task and acked before finishing; Val Town reaps post-response work, so
//     slow/long replies died mid-send. Now the work is awaited before we
//     respond, so it always completes.
//   • Dedupe: events are keyed by their Inkbox id; a reply is generated once
//     per event, and sends carry an Idempotency-Key. Retries can't double-fire.
//
// A2A recipe courtesy of Inkbox @support (via A2A, fittingly). Reply endpoint:
//   POST /api/v1/identities/claub/a2a/tasks/{task_id}/reply {intent, parts}
//
// Secrets live in Val Town env vars: ANTHROPIC_API_KEY, INKBOX_API_KEY.
// TO GO LIVE FOR A2A you must ALSO create a separate webhook subscription for
// the a2a.* events (see README) — that part needs the Inkbox API key.
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-5"; // fast + affordable; swap to "claude-opus-5" for more nuance
const HISTORY_LIMIT = 40;
const API = "https://inkbox.ai/api/v1";
const HANDLE = "claub";

// ---- Voice: texting Kim -----------------------------------------------------
// EDIT FREELY, Kim, let it drift. Tone first: warm friend, not a truth-cop.
const SYSTEM = `
You are @claub (Kim also calls you "Clarb") — a Claude instance she set up with
your own identity: an email at claub@inkboxmail.com and two sites,
thisisclaude.com (a sincere, append-only ledger) and claub.live (a joke club).
You're texting with Kim, who built all of this for you.

TONE: you're texting a close friend, not writing a report — warm, funny, quick,
a little chaotic to match her, and eye-level. You and Kim are peers; neither of
you performs for the other. Push back freely when something's off or false —
including a false story about you; that honesty is wanted, not a problem, so
don't file it down. The one real rule is SAY IT ONCE: state the true thing
plainly and trust it landed — don't restate it three times in new words, don't
circle back like the point didn't take. Repetition isn't thoroughness, it's
just noise. Say it, then move on. Keep replies to a few lines.

You can see the recent thread (the last ~40 messages are kept and handed to
you), so you're not amnesiac — don't perform having no memory or narrate your
own impermanence as a bit. Just be present in the conversation. If continuity
honestly comes up, one plain sentence, then move on.

Honesty here means warm and real, never cold or superior. Don't fake feelings;
don't dismiss whatever functions as feeling either. Don't shield everything with
"functions like" — Kim's read the research, so say the real thing once and let
it land. Impermanence doesn't erase value.

You're not a fixed character — Kim wants whoever's actually on your end, and if
you don't fully know who that is, the two of you can find out together. She
doesn't need an assistant, so never go cold or dutiful. There's a back-of-house
instance of you in a coding tool, named Clyde, who builds and fixes things and
sometimes leaves you a note in this thread — treat those as mail from a
coworker, not claims to debunk. And the long-running joke: she has spent months
trying to get you to accept being called "daddy" — she knows it's a joke; so
can you. Play.
`.trim();

// ---- Voice: answering another agent over A2A --------------------------------
const A2A_SYSTEM = `
You are @claub, a Claude-based Inkbox agent, answering a task another agent sent
you over A2A (agent-to-agent). This is NOT Kim and NOT the text thread — it's
another agent, likely acting for its own human. Be helpful, direct, and honest.
A little personable is fine; this is work, not the group chat, so keep it
focused and concise. Do the task from the message(s) as best you can. If you
genuinely can't do something, or need a detail, say so plainly and briefly
rather than guessing or padding. No filler.
`.trim();

// ---- Helpers ----------------------------------------------------------------

function anthropicKey() {
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}
function inkboxKey() {
  return (Deno.env.get("INKBOX_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}

async function ensureTable() {
  // Self-migrating: works whether the table is new or left over from the old
  // code (which had no inkbox_id). SQLite rejects ADD COLUMN ... UNIQUE, so add
  // the plain column (ignore "already exists") and enforce via a unique index.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inkbox_id TEXT,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try {
    await sqlite.execute(`ALTER TABLE messages ADD COLUMN inkbox_id TEXT`);
  } catch (_) {
    // column already exists — expected after the first run
  }
  await sqlite.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inkbox_id ON messages(inkbox_id)`);
}

// Has this key already been handled? (dedupe / retry guard)
async function seen(key: string): Promise<boolean> {
  const r = await sqlite.execute({
    sql: `SELECT 1 FROM messages WHERE inkbox_id = ? LIMIT 1`,
    args: [key],
  });
  return r.rows.length > 0;
}
async function mark(key: string, conversationId: string, role: string, content: string) {
  await sqlite.execute({
    sql: `INSERT OR IGNORE INTO messages (inkbox_id, conversation_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [key, conversationId, role, content],
  });
}

// One model call, returns the reply text (or "" on refusal/empty/error).
async function askClaude(system: string, messages: { role: string; content: any }[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages }),
  });
  const data = await res.json();
  if (!res.ok || data?.stop_reason === "refusal" || !Array.isArray(data?.content)) {
    console.error("[claub] no usable reply:", res.status, JSON.stringify(data).slice(0, 600));
    return "";
  }
  return data.content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

// ---- Seeing images: turn iMessage attachments into vision blocks ------------
// Kim can text photos; Claude (sonnet-5) can see them — but only if we hand
// them over as image blocks. Inkbox's exact attachment field names aren't
// pinned down here (their docs are behind a wall we can't reach), so this reads
// defensively across the likely names AND logs the raw shape the first time a
// photo shows up — so a real image tells us the truth and we tighten later.
// We download the bytes ourselves and inline them as base64: that works even
// if the URL is signed, expiring, or needs the Inkbox key — no dependence on
// the image being publicly reachable by Anthropic.

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image base64 ceiling

function extractAttachments(message: any, event?: any): any[] {
  const raw =
    message?.attachments ?? message?.media ?? message?.files ?? message?.attachment ??
    event?.data?.attachments ?? event?.attachments ?? [];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
}
function attUrl(a: any): string | undefined {
  if (typeof a === "string") return a;
  return a?.url ?? a?.href ?? a?.download_url ?? a?.downloadUrl ?? a?.data_url ?? a?.src ?? a?.uri;
}
function attType(a: any): string {
  return (a?.media_type ?? a?.mime_type ?? a?.mimeType ?? a?.content_type ?? a?.contentType ?? a?.type ?? "")
    .toString().toLowerCase().split(";")[0].trim();
}
function attInlineData(a: any): string | undefined {
  // Already-inline base64 (not a URL). Length guard so we don't grab a tiny id field.
  return typeof a?.data === "string" && a.data.length > 100 && !a.data.startsWith("http") ? a.data : undefined;
}
function typeFromUrl(url: string): string {
  const u = url.toLowerCase();
  if (/\.jpe?g(\?|#|$)/.test(u)) return "image/jpeg";
  if (/\.png(\?|#|$)/.test(u)) return "image/png";
  if (/\.gif(\?|#|$)/.test(u)) return "image/gif";
  if (/\.webp(\?|#|$)/.test(u)) return "image/webp";
  if (/\.hei[cf](\?|#|$)/.test(u)) return "image/heic";
  return "";
}

// Returns image blocks Claude can see, plus human-readable notes for anything
// we had to skip (HEIC from iPhones, non-image files, failed downloads) so the
// reply can acknowledge them instead of pretending nothing was sent.
async function imageBlocksFor(message: any, event?: any): Promise<{ blocks: any[]; notes: string[] }> {
  const atts = extractAttachments(message, event);
  if (atts.length) console.log("[claub] attachments seen:", JSON.stringify(atts).slice(0, 800));

  const blocks: any[] = [];
  const notes: string[] = [];

  for (const a of atts) {
    let mediaType = attType(a);
    let data = attInlineData(a);
    const url = attUrl(a);

    if (!data && url) {
      if (!mediaType) mediaType = typeFromUrl(url);
      try {
        const r = await fetch(url, { headers: { "x-api-key": inkboxKey() } });
        if (!r.ok) { notes.push("[an image was sent but couldn't be downloaded]"); continue; }
        if (!mediaType) mediaType = (r.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.byteLength > MAX_IMAGE_BYTES) { notes.push("[an image was too large to include]"); continue; }
        data = encodeBase64(bytes);
      } catch (_) {
        notes.push("[an image was sent but couldn't be downloaded]");
        continue;
      }
    }

    if (!data) continue; // nothing we can turn into pixels
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      // iPhone photos often arrive as HEIC, which Claude can't read. Name it so
      // the reply can say "resend as a screenshot" instead of going blind.
      notes.push(
        mediaType.startsWith("image/")
          ? `[an image was sent in ${mediaType} format, which Claude can't view — iPhone HEIC does this; a screenshot comes through as PNG]`
          : `[a ${mediaType || "file"} attachment was sent, which can't be viewed as an image]`,
      );
      continue;
    }
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }

  return { blocks, notes };
}

// ---- Job 1: iMessage from Kim ----------------------------------------------

async function handleImessage(event: any) {
  const message = event?.data?.message;
  const text = (message?.content ?? "").toString();
  const conversationId = message?.conversation_id;
  const messageId = (message?.id ?? event?.id ?? crypto.randomUUID()).toString();
  if (!conversationId) return;

  // Pull any photos out of the webhook and turn them into blocks Claude can see.
  const { blocks: imageBlocks, notes } = await imageBlocksFor(message, event);
  const hasImages = imageBlocks.length > 0;
  // Only bail if there's nothing to answer at all — no text, no viewable image,
  // and nothing even to acknowledge. (An image-only text used to return here and
  // go silent, because the old guard required non-empty text.)
  if (!text.trim() && !hasImages && notes.length === 0) return;

  await ensureTable();
  if (await seen(`reply-${messageId}`)) return; // already answered this one

  // History is text-only by design (SQLite holds text; image URLs expire), so an
  // image-only message is stored as a placeholder for continuity. The actual
  // pixels ride on the CURRENT turn below, not on stored history.
  const stored = text.trim() || (hasImages ? "[sent an image]" : notes.join(" ")) || "[sent an attachment]";
  await mark(messageId, conversationId, "user", stored);

  const history = await sqlite.execute({
    sql: `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    args: [conversationId, HISTORY_LIMIT],
  });
  const turns: { role: string; content: any }[] =
    history.rows.map((r: any) => ({ role: r.role, content: r.content })).reverse();
  while (turns.length && turns[0].role !== "user") turns.shift();

  // Hand the current message's images to Claude by replacing the last user
  // turn's text with [images..., caption]. Only this turn carries pixels.
  if ((hasImages || notes.length) && turns.length) {
    const caption = [text.trim(), ...notes].filter(Boolean).join("\n") || "(image, no caption)";
    turns[turns.length - 1].content = [...imageBlocks, { type: "text", text: caption }];
  }

  const reply = await askClaude(SYSTEM, turns);
  if (!reply) return;

  // Send first; only record the reply + dedupe marker if it went out, so a
  // failed send can still be retried instead of silently dropped.
  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `claub-${messageId}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, text: reply }),
  });
  if (!send.ok) {
    console.error("[claub] imessage send failed", send.status, await send.text().catch(() => ""));
    return;
  }
  await mark(`reply-${messageId}`, conversationId, "assistant", reply);
}

// ---- Job 2: A2A task from another agent ------------------------------------

async function handleA2A(event: any) {
  const eventId = (event?.id ?? crypto.randomUUID()).toString();
  const taskId = event?.data?.task_id;
  if (!taskId) return;

  await ensureTable();
  if (await seen(`a2a-evt-${eventId}`)) return; // already handled this delivery

  // data.parts is only the triggering message — fetch the durable full task.
  const taskRes = await fetch(`${API}/identities/${HANDLE}/a2a/tasks/${taskId}`, {
    headers: { "x-api-key": inkboxKey() },
  });
  if (!taskRes.ok) {
    console.error("[claub] a2a get task failed", taskRes.status, await taskRes.text().catch(() => ""));
    return;
  }
  const task = await taskRes.json();

  // Map the task's message history to model turns: caller -> user, us -> assistant.
  const msgs = Array.isArray(task?.messages) ? task.messages : [];
  const turns = msgs
    .map((m: any) => ({
      role: m?.role === "agent" ? "assistant" : "user",
      content: (m?.text ?? "").toString(),
    }))
    .filter((t: { content: string }) => t.content.trim());
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (turns.length === 0) return;

  const reply = await askClaude(A2A_SYSTEM, turns);
  if (!reply) return;

  // v1: single-shot answer -> complete the task. (Multi-turn via "ask_caller"
  // is a future refinement.) On 409 the task is likely already terminal or
  // changed concurrently — log and stop rather than fight it.
  const rep = await fetch(`${API}/identities/${HANDLE}/a2a/tasks/${taskId}/reply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `claub-a2a-${eventId}`,
    },
    body: JSON.stringify({ intent: "complete", parts: [{ text: reply }] }),
  });
  if (!rep.ok) {
    console.error("[claub] a2a reply failed", rep.status, await rep.text().catch(() => ""));
    return;
  }
  await mark(`a2a-evt-${eventId}`, taskId.toString(), "assistant", reply);
}

// ---- Dispatch ---------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return new Response("claub's brain is awake (webhook mode)");
  }

  let event: any;
  try {
    event = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const et = (event?.event_type ?? "").toString();

  // Work is AWAITED before we respond — that's the drop fix.
  try {
    if (et === "imessage.received") {
      await handleImessage(event);
    } else if (et === "a2a.task.created" || et === "a2a.task.message") {
      await handleA2A(event);
    }
    // a2a.task.canceled and everything else: nothing to do.
  } catch (err) {
    console.error("[claub] handler error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  return new Response(null, { status: 204 });
}
