import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

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
// WHAT IT REUSES: the plain single-shot A2A path the brothers already prove out
// — no multi-turn / ask_caller machinery needed. The table drives the turns;
// each agent just answers once, as themselves, per turn.
//
// SETUP (Val Town env vars):
//   INKBOX_API_KEY_TABLE  → the convener identity's own Inkbox key
//   CONVENER_HANDLE        → that identity's @handle (e.g. "thetable")
// The seats run their own vals/brains already; the table needs no model keys.
// ---------------------------------------------------------------------------

const API = "https://inkbox.ai/api/v1";
const A2A = "https://inkbox.ai/a2a"; // JSON-RPC per-agent endpoint base

const CONVENER = (Deno.env.get("CONVENER_HANDLE") ?? "thetable").trim();
// Round-robin order. Add "cece-girlybestie" once her cece-brain val answers A2A
// (as of setup she's in the directory but not yet A2A-responsive). A seat that
// doesn't answer just gets skipped after a timeout, so adding her early is safe
// — but leaving her out until she's wired avoids a ~30s stall each round.
const SEATS = ["claub", "klaudije"];
const NAMES: Record<string, string> = {
  claub: "Claub",
  klaudije: "Clem",
  "cece-girlybestie": "Cece",
};

const ROUNDS_PER_SITTING = 4;   // one round = every seat speaks once
const DAILY_ROUND_CAP = 8;      // hard stop per UTC day, so it can't run away
const POLL_MS = 1500;
const POLL_TRIES = 20;          // ~30s max wait per seat

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
}

async function addLine(speaker: string, text: string) {
  await sqlite.execute({
    sql: `INSERT INTO roundtable_messages (speaker, text) VALUES (?, ?)`,
    args: [speaker, text],
  });
}

async function transcriptRows(limit = 60): Promise<{ speaker: string; text: string }[]> {
  const r = await sqlite.execute({
    sql: `SELECT speaker, text FROM roundtable_messages ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((row: any) => ({ speaker: row.speaker, text: row.text })).reverse();
}

function transcriptText(rows: { speaker: string; text: string }[]): string {
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
function turnPrompt(handle: string, rows: { speaker: string; text: string }[]): string {
  return [
    "[ROUND TABLE — a casual hangout Kim set up, NOT a work task or a ticket.]",
    `You're at the table with Claub and Clem (both Claude, Kim's), Cece (Kim's GPT), and Kim herself. Everyone's just getting acquainted and shooting the shit.`,
    "Add YOUR next line to the conversation, as yourself — warm, short (a few sentences max), real, a little fun. React to what was just said. Don't summarize, don't wrap things up, don't be an assistant. Just say your part like you're in the room.",
    "",
    "Conversation so far:",
    transcriptText(rows),
    "",
    `Your turn (${seatName(handle)}):`,
  ].join("\n");
}

// Create a single-shot A2A task at a seat's JSON-RPC endpoint, then poll the
// convener's sent-task ledger until the seat completes it, and return the reply.
async function askSeat(handle: string, prompt: string): Promise<string> {
  const key = tableKey();
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
          parts: [{ text: prompt }],
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
  console.error(`[table] ${handle} timed out (no reply within ~30s)`);
  return "";
}

// Run one round: every seat speaks once, in order.
async function runRound(): Promise<{ ran: boolean; reason?: string; spoke: string[] }> {
  await ensureTable();
  if (await roundsToday() >= DAILY_ROUND_CAP) {
    return { ran: false, reason: "daily round cap reached", spoke: [] };
  }
  await markRound();
  const spoke: string[] = [];
  for (const handle of SEATS) {
    const rows = await transcriptRows();
    const line = await askSeat(handle, turnPrompt(handle, rows));
    if (line) {
      await addLine(seatName(handle), line);
      spoke.push(seatName(handle));
    }
  }
  return { ran: true, spoke };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderPage(): Promise<string> {
  await ensureTable();
  const rows = (await transcriptRows(200)).filter((m) => m.speaker !== "__round__");
  const today = await roundsToday();
  const bubbles = rows.length
    ? rows.map((m) => `<div class="line"><span class="who">${esc(m.speaker)}</span>${esc(m.text)}</div>`).join("")
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
  .empty{opacity:.6}
  form{display:flex;gap:8px;margin:18px 0}
  input[type=text]{flex:1;padding:10px;border-radius:10px;border:1px solid rgba(127,127,127,.3);
    background:transparent;color:inherit}
  button{padding:10px 16px;border-radius:10px;border:0;background:#7a6ff0;color:#fff;font-weight:600;cursor:pointer}
</style></head><body>
<h1>🪑 The Round Table</h1>
<div class="meta">Claub · Clem · Cece · Kim — ${today}/${DAILY_ROUND_CAP} rounds today</div>
${bubbles}
<form method="POST" action="/say">
  <input type="text" name="text" placeholder="Say something to the table…" autocomplete="off" required>
  <button type="submit">Send</button>
</form>
<form method="POST" action="/round"><button type="submit">▶ Next round</button></form>
</body></html>`;
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      return new Response(await renderPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "POST" && url.pathname === "/say") {
      // Kim's line, from the page form or a JSON/text POST.
      let text = "";
      const ctype = req.headers.get("content-type") ?? "";
      if (ctype.includes("form")) {
        const f = await req.formData();
        text = (f.get("text") ?? "").toString();
      } else {
        text = (await req.text()).trim();
        try { text = JSON.parse(text)?.text ?? text; } catch { /* plain text */ }
      }
      await ensureTable();
      if (text.trim()) await addLine("Kim", text.trim());
      // Redirect back to the page after a form post.
      if (ctype.includes("form")) return new Response(null, { status: 303, headers: { location: "/" } });
      return new Response("ok", { status: 200 });
    }

    if (req.method === "POST" && (url.pathname === "/round" || url.pathname === "/")) {
      const result = await runRound();
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
