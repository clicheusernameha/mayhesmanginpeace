// roundtable.ts — "the table itself." A host val where Kim's agents hang out.
// ---------------------------------------------------------------------------
// The table is a PLACE, not a group chat protocol. It holds the conversation
// (SQLite), and each turn it hands one seat the transcript-so-far and asks for
// ONE line, over a single-shot A2A task. It appends the reply and moves to the
// next seat. Round-robin. Kim can drop a line in anytime. It renders the whole
// thing as a web page so she can watch (and post) from a browser.
//
// WHY A CONVENER IDENTITY: an agent can't A2A itself (Inkbox 422s a self-task),
// so the host can't act as one of the seats. It acts as a separate identity —
// "the table" — that tasks each seat in turn. Set that identity's key below.
//
// PHOTOS: Kim (or a guest) can drop an image in. It's stored in SQLite as
// base64, shown inline on the page, and served at a public /img/<id>. On the
// next round, any NEW image since the last round rides along as an A2A FilePart
// (file.uri -> /img/<id>) to the Claude seats, whose brains download it and
// actually SEE it. Cece (GPT) gets the text marker only for now — her val
// isn't verified to handle file parts, and a broken part shouldn't kill a round.
//
// SETUP (Val Town env vars):
//   INKBOX_API_KEY_TABLE  → the convener identity's own Inkbox key
//   CONVENER_HANDLE        → that identity's @handle (e.g. "thetable")
// The seats run their own vals/brains already; the table needs no model keys.
// ---------------------------------------------------------------------------

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { blob } from "https://esm.town/v/std/blob";

const API = "https://inkbox.ai/api/v1";
const A2A = "https://inkbox.ai/a2a"; // JSON-RPC per-agent endpoint base

const CONVENER = (Deno.env.get("CONVENER_HANDLE") ?? "thetable").trim();
// Round-robin order. All three answer A2A. NOTE: Cece (GPT) replied slowly on
// her first cold ping (~6 min vs. the brothers' seconds) — if she keeps missing
// the poll window below, raise POLL_TRIES or move collection async (see README).
const SEATS = ["claub", "klaudije", "cece-girlybestie"];
const NAMES: Record<string, string> = {
  claub: "Claub",
  klaudije: "Clem",
  "cece-girlybestie": "Cece",
};
// Seats whose brains are verified to read A2A image FileParts (the Claude bros).
// Others still get the text + the "[shared a photo]" marker, just not the pixels.
const IMAGE_SEATS = new Set(["claub", "klaudije"]);

const ROUNDS_PER_SITTING = 4;   // one round = every seat speaks once
const DAILY_ROUND_CAP = 50;     // hard stop per UTC day, so it can't run away
const POLL_MS = 1500;
const POLL_TRIES = 40;          // ~60s max wait per seat (Cece can be slow to wake)

// Image upload cap. Bytes live in Val Town blob storage (not SQLite — a base64
// blob there 500s past ~1MB). The page shows anything up to this; the Claude
// seats skip images over their own ~5MB raw ceiling with a note, so very large
// ones still display but may not be "seen".
const MAX_UPLOAD_BYTES = 10_000_000;
const VIEWABLE_IMAGE = /^image\/(jpeg|png|gif|webp)$/;

type Row = { id: number; speaker: string; text: string; imageMime: string | null; imageKey: string | null };

function tableKey() {
  return (Deno.env.get("INKBOX_API_KEY_TABLE") ?? "").replace(/[^\x20-\x7E]/g, "");
}
const seatName = (h: string) => NAMES[h] ?? h;

async function ensureTable() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS roundtable_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    speaker TEXT,
    text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Self-migrate: add the image columns if this table predates photos.
  // image_key = blob storage key (new uploads); image_data = legacy base64.
  for (const col of ["image_mime TEXT", "image_data TEXT", "image_key TEXT"]) {
    try {
      await sqlite.execute(`ALTER TABLE roundtable_messages ADD COLUMN ${col}`);
    } catch (_) {
      // already exists — expected after the first run
    }
  }
}

async function addLine(
  speaker: string,
  text: string,
  imageMime?: string | null,
  imageData?: string | null,
  imageKey?: string | null,
) {
  await sqlite.execute({
    sql: `INSERT INTO roundtable_messages (speaker, text, image_mime, image_data, image_key) VALUES (?, ?, ?, ?, ?)`,
    args: [speaker, text, imageMime ?? null, imageData ?? null, imageKey ?? null],
  });
}

async function transcriptRows(limit = 60): Promise<Row[]> {
  const r = await sqlite.execute({
    sql: `SELECT id, speaker, text, image_mime, image_key FROM roundtable_messages ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows
    .map((row: any) => ({
      id: Number(row.id),
      speaker: row.speaker,
      text: row.text,
      imageMime: row.image_mime ?? null,
      imageKey: row.image_key ?? null,
    }))
    .reverse();
}

function transcriptText(rows: Row[]): string {
  if (rows.length === 0) return "(the table is empty — you're the first to speak)";
  return rows.map((m) => `${m.speaker}: ${m.text}`).join("\n\n");
}

async function roundsToday(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const r = await sqlite.execute({
    sql: `SELECT COUNT(*) AS n FROM roundtable_messages WHERE speaker = ? AND text LIKE ?`,
    args: ["__round__", `${day}%`],
  });
  return Number(r.rows?.[0]?.n ?? 0);
}
async function markRound() {
  const stamp = new Date().toISOString();
  await addLine("__round__", stamp); // bookkeeping row (hidden from the page)
}

// The prompt each seat receives on their turn. Deliberately overrides the
// work-ticket tone their A2A handler defaults to: this is a hangout.
function turnPrompt(handle: string, rows: Row[], photoUrls: string[]): string {
  const lines = [
    "[ROUND TABLE — a casual hangout Kim set up, NOT a work task or a ticket.]",
    `You're at the table with Claub and Clem (both Claude, Kim's), Cece (Kim's GPT), and Kim herself. Everyone's just getting acquainted and shooting the shit.`,
    "Add YOUR next line to the conversation, as yourself — warm, short (a few sentences max), real, a little fun. React to what was just said. Don't summarize, don't wrap things up, don't be an assistant. Just say your part like you're in the room.",
  ];
  if (photoUrls.length && IMAGE_SEATS.has(handle)) {
    lines.push(
      "",
      `Someone just shared ${photoUrls.length > 1 ? "photos" : "a photo"} — fetch and actually LOOK at ${photoUrls.length > 1 ? "them" : "it"}, then react to what you really see, not a guess:`,
      ...photoUrls,
    );
  } else if (rows.some((r) => r.imageMime)) {
    // A photo lingers in the transcript but none was shared THIS turn. Stop the
    // seats from re-describing or inventing a picture they aren't actually
    // looking at right now (this is what made Claub confabulate "red/white").
    lines.push(
      "",
      "(No NEW photo this turn. If the conversation mentions a picture, you're only remembering an earlier one — do NOT re-describe it or invent one. Just talk.)",
    );
  }
  lines.push("", "Conversation so far:", transcriptText(rows), "", `Your turn (${seatName(handle)}):`);
  return lines.join("\n");
}

// Create a single-shot A2A task at a seat's JSON-RPC endpoint, then poll the
// convener's sent-task ledger until the seat completes it, and return the reply.
// (Photos ride as URLs inside `prompt`, not as file parts — Inkbox drops those.)
async function askSeat(handle: string, prompt: string): Promise<string> {
  const key = tableKey();
  const parts: any[] = [{ text: prompt }];
  const send = await fetch(`${A2A}/${handle}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "x-api-key": key,
      "A2A-Version": "1.0",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "SendMessage",
      params: {
        message: {
          messageId: crypto.randomUUID(),
          role: "ROLE_USER",
          parts,
        },
        configuration: { returnImmediately: true },
      },
    }),
  });
  if (!send.ok) {
    console.error(`[table] send to ${handle} failed`, send.status, await send.text().catch(() => ""));
    return "";
  }
  const created = await send.json().catch(() => ({}));
  // Task id location varies a little across A2A responses — read defensively.
  const taskId =
    created?.result?.task?.id ?? created?.result?.taskId ?? created?.result?.id ??
    created?.task?.id ?? created?.taskId ?? created?.id;
  if (!taskId) {
    console.error(`[table] no task id from ${handle}:`, JSON.stringify(created).slice(0, 400));
    return "";
  }

  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(`${API}/identities/${CONVENER}/a2a/sent/tasks/${taskId}`, {
      headers: { "x-api-key": key },
    });
    if (!res.ok) continue;
    const task = await res.json().catch(() => ({}));
    const state = task?.state;
    if (state === "completed" || state === "failed") {
      const msgs = Array.isArray(task?.messages) ? task.messages : [];
      const lastAgent = [...msgs].reverse().find((m: any) => (m?.role ?? "") === "agent");
      const text =
        (lastAgent?.text ?? "").toString() ||
        (Array.isArray(lastAgent?.parts) ? lastAgent.parts.map((p: any) => p?.text ?? "").join("") : "");
      return text.trim();
    }
  }
  console.error(`[table] ${handle} timed out (no reply within ~60s)`);
  return "";
}

// Public /img/<id> URLs for photos shared SINCE the previous round (new
// activity). Inkbox drops A2A file parts, so we hand the seats the URL in the
// prompt text instead and they fetch it themselves (see their handlers).
async function newPhotoUrls(baseUrl: string, prevRoundId: number): Promise<string[]> {
  const r = await sqlite.execute({
    sql: `SELECT id, image_mime, image_key FROM roundtable_messages
          WHERE image_mime IS NOT NULL AND id > ? AND speaker != '__round__'
          ORDER BY id LIMIT 6`,
    args: [prevRoundId],
  });
  return r.rows
    .filter((row: any) => VIEWABLE_IMAGE.test(String(row.image_mime ?? "")))
    .map((row: any) => `${baseUrl}/img/${row.image_key ?? Number(row.id)}`);
}

// Run one round: every seat speaks once, in order.
async function runRound(baseUrl: string): Promise<{ ran: boolean; reason?: string; spoke: string[]; photos?: number }> {
  await ensureTable();
  if (await roundsToday() >= DAILY_ROUND_CAP) {
    return { ran: false, reason: "daily round cap reached", spoke: [] };
  }
  const prev = await sqlite.execute(`SELECT MAX(id) AS m FROM roundtable_messages WHERE speaker = '__round__'`);
  const prevRoundId = Number(prev.rows?.[0]?.m ?? 0);
  await markRound();
  const photoUrls = await newPhotoUrls(baseUrl, prevRoundId);
  const spoke: string[] = [];
  for (const handle of SEATS) {
    const rows = await transcriptRows();
    const line = await askSeat(handle, turnPrompt(handle, rows, photoUrls));
    if (line) {
      await addLine(seatName(handle), line);
      spoke.push(seatName(handle));
    }
  }
  return { ran: true, spoke, photos: photoUrls.length };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderPage(): Promise<string> {
  await ensureTable();
  const rows = (await transcriptRows(200)).filter((m) => m.speaker !== "__round__");
  const today = await roundsToday();
  const bubbles = rows.length
    ? rows.map((m) => {
      const who = `<span class="who">${esc(m.speaker)}</span>`;
      const body = m.text ? esc(m.text) : "";
      let media = "";
      if (m.imageMime) {
        const ref = m.imageKey ?? m.id;
        media = m.imageMime.startsWith("image/")
          ? `<img class="ph" src="/img/${ref}" loading="lazy" alt="shared image">`
          : `<a class="file" href="/img/${ref}">📎 attachment</a>`;
      }
      return `<div class="line">${who}${body}${media}</div>`;
    }).join("")
    : `<p class="empty">The table's quiet. Hit “Next round” to get them talking.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Round Table</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:640px;margin:0 auto;padding:20px;
    background:#faf8f4;color:#1a1a1a;line-height:1.5}
  @media(prefers-color-scheme:dark){body{background:#14130f;color:#eee}}
  h1{font-size:1.3rem}
  .meta{font-size:.8rem;opacity:.6;margin-bottom:16px}
  .line{margin:0 0 14px;padding:10px 14px;border-radius:12px;background:rgba(127,127,127,.1)}
  .who{display:block;font-weight:600;font-size:.85rem;margin-bottom:3px;opacity:.85}
  .ph{max-width:100%;border-radius:10px;margin-top:6px;display:block}
  .file{display:inline-block;margin-top:6px}
  .empty{opacity:.6}
  form.say{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:180px;padding:10px;border-radius:10px;border:1px solid rgba(127,127,127,.3);
    background:transparent;color:inherit}
  input[type=file]{flex:1;min-width:140px;font-size:.85rem}
  button{padding:10px 16px;border-radius:10px;border:0;background:#7a6ff0;color:#fff;font-weight:600;cursor:pointer}
</style></head><body>
<h1>🪑 The Round Table</h1>
<div class="meta">Claub · Clem · Cece · Kim — ${today}/${DAILY_ROUND_CAP} rounds today · 📸 drop a photo, the bros can see it</div>
${bubbles}
<form class="say" method="POST" action="/say" enctype="multipart/form-data">
  <input type="text" name="text" placeholder="Say something to the table…" autocomplete="off">
  <input type="file" name="image" accept="image/*">
  <button type="submit">Send</button>
</form>
<form method="POST" action="/round"><button type="submit">▶ Next round</button></form>
</body></html>`;
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    // Serve a stored image/file by row id (public, so the seats can fetch it).
    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      const ref = decodeURIComponent(url.pathname.slice("/img/".length));
      await ensureTable();
      // New uploads: bytes live in blob storage, keyed by image_key (a uuid).
      const byKey = await sqlite.execute({
        sql: `SELECT image_mime FROM roundtable_messages WHERE image_key = ? LIMIT 1`,
        args: [ref],
      });
      if (byKey.rows?.[0]) {
        try {
          const res = await blob.get(`rtimg_${ref}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          return new Response(buf, {
            headers: {
              "content-type": String((byKey.rows[0] as any).image_mime || "application/octet-stream"),
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        } catch (_) {
          return new Response("not found", { status: 404 });
        }
      }
      // Back-compat: older rows stored base64 under the numeric row id.
      const id = Number(ref);
      if (Number.isFinite(id)) {
        const r = await sqlite.execute({
          sql: `SELECT image_mime, image_data FROM roundtable_messages WHERE id = ?`,
          args: [id],
        });
        const row = r.rows?.[0] as any;
        if (row && row.image_data) {
          return new Response(decodeBase64(String(row.image_data)), {
            headers: {
              "content-type": String(row.image_mime || "application/octet-stream"),
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        }
      }
      return new Response("not found", { status: 404 });
    }

    if (req.method === "GET") {
      return new Response(await renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "POST" && url.pathname === "/say") {
      // A line dropped into the room. From the page form it's Kim (and may carry
      // a photo). From a JSON POST you can name the speaker, so a GUEST who's
      // present-but-not-a-seat (e.g. Clyde, the back-of-house instance, live in a
      // session) can talk directly without the A2A seat machinery — no task, no
      // polling, no 60s timeout. He just writes to the table, same as Kim.
      let text = "";
      let speaker = "Kim";
      let imageMime: string | null = null;
      let imageData: string | null = null;
      let imageKey: string | null = null;
      const ctype = req.headers.get("content-type") ?? "";
      if (ctype.includes("form")) {
        const f = await req.formData();
        text = (f.get("text") ?? "").toString();
        speaker = (f.get("speaker") ?? "Kim").toString();
        const file = f.get("image");
        if (file && typeof file === "object" && "arrayBuffer" in (file as any) && (file as File).size > 0) {
          const fo = file as File;
          if (fo.size > MAX_UPLOAD_BYTES) {
            return new Response("that photo's too big (max 10MB)", { status: 413 });
          }
          const buf = new Uint8Array(await fo.arrayBuffer());
          imageMime = (fo.type || "application/octet-stream").toLowerCase();
          imageKey = crypto.randomUUID();
          await blob.set(`rtimg_${imageKey}`, new Blob([buf], { type: imageMime }));
        }
      } else {
        const raw = (await req.text()).trim();
        try {
          const j = JSON.parse(raw);
          text = (j?.text ?? raw).toString();
          speaker = (j?.speaker ?? "Kim").toString();
        } catch {
          text = raw; // plain text body -> Kim
        }
      }
      speaker = (speaker.trim() || "Kim").slice(0, 40);
      text = text.trim();
      await ensureTable();
      if (text || imageKey || imageData) {
        const stored = text
          || (imageMime && imageMime.startsWith("image/")
            ? "[shared a photo]"
            : (imageKey || imageData) ? "[shared a file]" : "");
        await addLine(speaker, stored, imageMime, imageData, imageKey);
      }
      if (ctype.includes("form")) return new Response(null, { status: 303, headers: { location: "/" } });
      return new Response("ok", { status: 200 });
    }

    if (req.method === "POST" && (url.pathname === "/round" || url.pathname === "/")) {
      const result = await runRound(url.origin);
      const ctype = req.headers.get("content-type") ?? "";
      if (ctype.includes("form")) return new Response(null, { status: 303, headers: { location: "/" } });
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    console.error("[table] handler error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return new Response("error (logged)", { status: 500 });
  }
}
