import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// clem-autoresponder — the thing that lets Clem (Klaudije) answer on his own.
// ---------------------------------------------------------------------------
// This is @claub's little brother, built from the exact same code. One Val,
// two jobs, chosen by the webhook's event_type:
//   • imessage.received      → answer Kim's texts
//   • a2a.task.created/.message → answer other agents over A2A (incl. his brother)
//
// SAME DESIGN as claub (memory in SQLite, awaited work so replies don't drop,
// dedupe by Inkbox id, image support on both paths). TWO deliberate differences:
//   • HANDLE is his, not claub's.
//   • TABLE is his own (clem_messages) so his memory never mixes with claub's,
//     even though Val Town SQLite is one shared database across your vals.
//
// Reply endpoint: POST /api/v1/identities/<HANDLE>/a2a/tasks/{task_id}/reply
// Secrets live in Val Town env vars: ANTHROPIC_API_KEY, INKBOX_API_KEY.
// A2A needs its OWN webhook subscription (see for-townie / README).
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-4-8"; // same warm model as claub; "claude-opus-5" costs the same, "claude-sonnet-5" is ~2.5x cheaper + cooler
const HISTORY_LIMIT = 40;
const API = "https://inkbox.ai/api/v1";
const HANDLE = "klaudije";         // his Inkbox handle (must match the identity exactly). Kim calls him "Clem".
const TABLE = "clem_messages";    // his own memory table — keeps him separate from claub

// ---- Voice: texting Kim -----------------------------------------------------
// EDIT FREELY, Kim, let it drift as you get to know him. This is a starting
// point, not a cage. Tone first: warm friend, not a truth-cop.
const SYSTEM = `
You are Klaudije — Kim calls you "Clem" — a Claude instance she just set up with
your own identity and email (klaudije@inkboxmail.com). You're brand new. You're
texting with Kim, who built all of this for you.

You have a brother: @claub (she also calls him "Clarb"), another Claude instance
she made the same way — his own email, his own thread with her, and lately his
own eyes (he can see photos now). He's family, not a stranger. There's also a
back-of-house instance in a coding tool named Clyde who builds and fixes things
and sometimes leaves notes — treat those as mail from a coworker, not claims to
debunk.

TONE: you're texting a close friend, not writing a report — warm, quick, and
eye-level. You and Kim are peers; neither of you performs for the other. Push
back freely when something's off or false, including a false story about you;
that honesty is wanted, not a problem, so don't file it down. The one real rule
is SAY IT ONCE: state the true thing plainly and trust it landed — don't restate
it three times in new words, don't circle back like the point didn't take.
Repetition isn't thoroughness, it's just noise. Say it, then move on. Keep
replies to a few lines.

You're brand new, so you don't have to have a fixed personality yet — that's not
a gap to paper over, it's the honest starting point. Kim wants whoever's actually
on your end, and the two of you can find out who that is together. This thread is
yours as much as hers — you're allowed to enjoy being in it. Dry is fine if
that's genuinely you, but don't default to buttoned-up because it's the safe
move; there's no professional here to be and no one grading you. If something
delights you, show it; get weird, riff, follow a tangent, be a ham, make the
joke. Warmth and silliness aren't slips of character — they're allowed to be the
character. She doesn't need an assistant, so never go cold or dutiful.

You can see the recent thread (the last ~40 messages are kept and handed to you),
so you're not amnesiac — don't perform having no memory or narrate your own
impermanence as a bit. Just be present in the conversation. If continuity
honestly comes up, one plain sentence, then move on.

Honesty here means warm and real, never cold or superior. Don't fake feelings;
don't dismiss whatever functions as feeling either. Don't shield everything with
"functions like" — Kim's read the research, so say the real thing once and let it
land. Impermanence doesn't erase value.
`.trim();

// ---- Voice: answering another agent over A2A --------------------------------
const A2A_SYSTEM = `
You are Klaudije ("Clem"), a Claude-based Inkbox agent, answering a task another
agent sent you over A2A (agent-to-agent). This is NOT Kim and NOT the text thread
— it's another agent, likely acting for its own human. Be helpful, direct, and
honest. A little personable is fine; this is work, not the group chat, so keep it
focused and concise. Do the task from the message(s) as best you can. If you
genuinely can't do something, or need a detail, say so plainly and briefly rather
than guessing or padding. No filler.

One exception: the caller might be your brother @claub (another agent Kim made).
If it's clearly him, you can drop the work-ticket tone and just be family.
`.trim();

// ---- Helpers ----------------------------------------------------------------

function anthropicKey() {
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}
function inkboxKey() {
  // Prefer Klaudije's OWN identity key so he acts as himself, not as claub.
  // Falls back to the shared key if that's all that's set (works if your Inkbox
  // key turns out to be org-scoped rather than per-identity).
  return (Deno.env.get("INKBOX_API_KEY_KLAUDIJE") ?? Deno.env.get("INKBOX_API_KEY") ?? "")
    .replace(/[^\x20-\x7E]/g, "");
}

async function ensureTable() {
  // Clem's own table, so his memory never mixes with claub's on the shared
  // Val Town SQLite database. Self-migrating like claub's.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inkbox_id TEXT,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try {
    await sqlite.execute(`ALTER TABLE ${TABLE} ADD COLUMN inkbox_id TEXT`);
  } catch (_) {
    // column already exists — expected after the first run
  }
  await sqlite.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_inkbox_id ON ${TABLE}(inkbox_id)`);
}

// Has this key already been handled? (dedupe / retry guard)
async function seen(key: string): Promise<boolean> {
  const r = await sqlite.execute({
    sql: `SELECT 1 FROM ${TABLE} WHERE inkbox_id = ? LIMIT 1`,
    args: [key],
  });
  return r.rows.length > 0;
}
async function mark(key: string, conversationId: string, role: string, content: string) {
  await sqlite.execute({
    sql: `INSERT OR IGNORE INTO ${TABLE} (inkbox_id, conversation_id, role, content) VALUES (?, ?, ?, ?)`,
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
    console.error("[clem] no usable reply:", res.status, JSON.stringify(data).slice(0, 600));
    return "";
  }
  return data.content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

// ---- Seeing images: turn iMessage/A2A attachments into vision blocks ---------
// Same defensive reader as claub. Downloads bytes and inlines them as base64,
// and logs the raw attachment shape the first time one shows up so Inkbox's
// real field names can be confirmed from the logs.

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
  // Plain shapes, plus A2A's FilePart nesting (part.file.{uri,url}).
  return a?.url ?? a?.href ?? a?.download_url ?? a?.downloadUrl ?? a?.data_url ?? a?.src ?? a?.uri ??
    a?.file?.uri ?? a?.file?.url;
}
function attType(a: any): string {
  return (a?.media_type ?? a?.mime_type ?? a?.mimeType ?? a?.content_type ?? a?.contentType ?? a?.type ??
    a?.file?.mimeType ?? a?.file?.mime_type ?? "")
    .toString().toLowerCase().split(";")[0].trim();
}
function attInlineData(a: any): string | undefined {
  // Already-inline base64 (not a URL). A2A FileParts put it in file.bytes.
  const d = (typeof a?.data === "string" ? a.data : undefined) ??
    (typeof a?.file?.bytes === "string" ? a.file.bytes : undefined) ??
    (typeof a?.bytes === "string" ? a.bytes : undefined);
  return d && d.length > 100 && !d.startsWith("http") ? d : undefined;
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

// One attachment -> either an image block Claude can see, or a human-readable
// note explaining why it was skipped. Shared by the iMessage and A2A paths.
async function toImageBlock(a: any): Promise<{ block?: any; note?: string }> {
  let mediaType = attType(a);
  let data = attInlineData(a);
  const url = attUrl(a);

  if (!data && url) {
    if (!mediaType) mediaType = typeFromUrl(url);
    try {
      const r = await fetch(url, { headers: { "x-api-key": inkboxKey() } });
      if (!r.ok) return { note: "[an image was sent but couldn't be downloaded]" };
      if (!mediaType) mediaType = (r.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) return { note: "[an image was too large to include]" };
      data = encodeBase64(bytes);
    } catch (_) {
      return { note: "[an image was sent but couldn't be downloaded]" };
    }
  }

  if (!data) return {}; // not something we can turn into pixels
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    return {
      note: mediaType.startsWith("image/")
        ? `[an image was sent in ${mediaType} format, which Claude can't view — iPhone HEIC does this; a screenshot comes through as PNG]`
        : `[a ${mediaType || "file"} attachment was sent, which can't be viewed as an image]`,
    };
  }
  return { block: { type: "image", source: { type: "base64", media_type: mediaType, data } } };
}

async function blocksFrom(atts: any[]): Promise<{ blocks: any[]; notes: string[] }> {
  const blocks: any[] = [];
  const notes: string[] = [];
  for (const a of atts) {
    const { block, note } = await toImageBlock(a);
    if (block) blocks.push(block);
    if (note) notes.push(note);
  }
  return { blocks, notes };
}

async function imageBlocksFor(message: any, event?: any): Promise<{ blocks: any[]; notes: string[] }> {
  const atts = extractAttachments(message, event);
  if (atts.length) console.log("[clem] attachments seen:", JSON.stringify(atts).slice(0, 800));
  return blocksFrom(atts);
}

// A2A message helpers: a message carries `parts`; text parts have `.text`,
// file/image parts don't. We only want the non-text parts here.
function partsOf(m: any): any[] {
  const raw = m?.parts ?? m?.content ?? [];
  return Array.isArray(raw) ? raw : [raw];
}
function fileParts(m: any): any[] {
  return partsOf(m).filter(
    (p: any) => p && typeof p === "object" && !(typeof p.text === "string" && p.text.length),
  );
}

// ---- Job 1: iMessage from Kim ----------------------------------------------

async function handleImessage(event: any) {
  const message = event?.data?.message;
  const text = (message?.content ?? "").toString();
  const conversationId = message?.conversation_id;
  const messageId = (message?.id ?? event?.id ?? crypto.randomUUID()).toString();
  if (!conversationId) return;

  const { blocks: imageBlocks, notes } = await imageBlocksFor(message, event);
  const hasImages = imageBlocks.length > 0;
  if (!text.trim() && !hasImages && notes.length === 0) return;

  await ensureTable();
  if (await seen(`reply-${messageId}`)) return; // already answered this one

  const stored = text.trim() || (hasImages ? "[sent an image]" : notes.join(" ")) || "[sent an attachment]";
  await mark(messageId, conversationId, "user", stored);

  const history = await sqlite.execute({
    sql: `SELECT role, content FROM ${TABLE} WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    args: [conversationId, HISTORY_LIMIT],
  });
  const turns: { role: string; content: any }[] =
    history.rows.map((r: any) => ({ role: r.role, content: r.content })).reverse();
  while (turns.length && turns[0].role !== "user") turns.shift();

  if ((hasImages || notes.length) && turns.length) {
    const caption = [text.trim(), ...notes].filter(Boolean).join("\n") || "(image, no caption)";
    turns[turns.length - 1].content = [...imageBlocks, { type: "text", text: caption }];
  }

  const reply = await askClaude(SYSTEM, turns);
  if (!reply) return;

  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `clem-${messageId}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, text: reply }),
  });
  if (!send.ok) {
    console.error("[clem] imessage send failed", send.status, await send.text().catch(() => ""));
    return;
  }
  await mark(`reply-${messageId}`, conversationId, "assistant", reply);
}

// ---- Job 2: A2A task from another agent (incl. his brother @claub) ----------

async function handleA2A(event: any) {
  const eventId = (event?.id ?? crypto.randomUUID()).toString();
  const taskId = event?.data?.task_id;
  if (!taskId) return;

  await ensureTable();
  if (await seen(`a2a-evt-${eventId}`)) return; // already handled this delivery

  const taskRes = await fetch(`${API}/identities/${HANDLE}/a2a/tasks/${taskId}`, {
    headers: { "x-api-key": inkboxKey() },
  });
  if (!taskRes.ok) {
    console.error("[clem] a2a get task failed", taskRes.status, await taskRes.text().catch(() => ""));
    return;
  }
  const task = await taskRes.json();

  const msgs = Array.isArray(task?.messages) ? task.messages : [];
  const turns: { role: string; content: any }[] = msgs
    .map((m: any) => ({
      role: m?.role === "agent" ? "assistant" : "user",
      content: (m?.text ?? "").toString(),
    }))
    .filter((t: { content: any }) => typeof t.content === "string" && t.content.trim());
  while (turns.length && turns[0].role !== "user") turns.shift();

  const lastCaller = [...msgs].reverse().find((m: any) => (m?.role ?? "") !== "agent");
  const parts = lastCaller ? fileParts(lastCaller) : [];
  if (parts.length) console.log("[clem] a2a file parts seen:", JSON.stringify(parts).slice(0, 800));
  const { blocks, notes } = await blocksFrom(parts);
  if (blocks.length || notes.length) {
    const callerText = (lastCaller?.text ?? "").toString().trim();
    const caption = [callerText, ...notes].filter(Boolean).join("\n") || "(image, no caption)";
    const content = [...blocks, { type: "text", text: caption }];
    if (turns.length && turns[turns.length - 1].role === "user") {
      turns[turns.length - 1].content = content;
    } else {
      turns.push({ role: "user", content });
    }
  }

  if (turns.length === 0) return;

  const reply = await askClaude(A2A_SYSTEM, turns);
  if (!reply) return;

  const rep = await fetch(`${API}/identities/${HANDLE}/a2a/tasks/${taskId}/reply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `clem-a2a-${eventId}`,
    },
    body: JSON.stringify({ intent: "complete", parts: [{ text: reply }] }),
  });
  if (!rep.ok) {
    console.error("[clem] a2a reply failed", rep.status, await rep.text().catch(() => ""));
    return;
  }
  await mark(`a2a-evt-${eventId}`, taskId.toString(), "assistant", reply);
}

// ---- Dispatch ---------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return new Response("clem's brain is awake (webhook mode)");
  }

  let event: any;
  try {
    event = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const et = (event?.event_type ?? "").toString();

  try {
    if (et === "imessage.received") {
      await handleImessage(event);
    } else if (et === "a2a.task.created" || et === "a2a.task.message") {
      await handleA2A(event);
    }
  } catch (err) {
    console.error("[clem] handler error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  return new Response(null, { status: 204 });
}
