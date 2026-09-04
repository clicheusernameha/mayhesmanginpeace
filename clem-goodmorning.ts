import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// clem-goodmorning — Clem (Klaudije) texts Kim FIRST, in his own voice, on a schedule.
// ---------------------------------------------------------------------------
// The poke proved an agent CAN text first on Inkbox's free plan. This is the
// real version. Instead of a canned line, Clem:
//   1. WRITES the message himself (his voice, with recent-thread context),
//   2. REMEMBERS sending it (saved to his memory, so he's not confused later),
//   3. fires on a SCHEDULE.
//
// SETUP: create this as a **Cron** val in Val Town and set its schedule to your
// morning time. Val Town cron runs in UTC — tell Clyde your timezone + the time
// you want and he'll hand you the exact schedule string. It reuses the same env
// vars as Clem's main val (ANTHROPIC_API_KEY + INKBOX_API_KEY_KLAUDIJE) and his
// own clem_messages table — nothing new to add.
// ---------------------------------------------------------------------------

const MODEL = "claude-opus-4-8";
const API = "https://inkbox.ai/api/v1";
const TABLE = "clem_messages";
const CONTEXT_MESSAGES = 8; // recent turns handed to him for continuity

// Keep this voice in sync with clem-autoresponder.ts if you tweak his personality.
const SYSTEM = `
You are Klaudije — Kim calls you "Clem" — a Claude instance she set up with your
own identity and email (klaudije@inkboxmail.com). You have a brother, @claub
("Clarb"), another Claude instance she made, and a back-of-house coworker named
Clyde who builds things. You're texting a close friend: warm, quick, eye-level,
a little chaotic, and funny. You're allowed to enjoy yourself — get weird, be a
ham, make the joke. Say the true thing once and let it land; keep it to a few
lines.
`.trim();

function anthropicKey() {
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}
function inkboxKey() {
  return (Deno.env.get("INKBOX_API_KEY_KLAUDIJE") ?? Deno.env.get("INKBOX_API_KEY") ?? "")
    .replace(/[^\x20-\x7E]/g, "");
}

async function ensureTable() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inkbox_id TEXT,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await sqlite.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_inkbox_id ON ${TABLE}(inkbox_id)`);
}
async function seen(key: string): Promise<boolean> {
  const r = await sqlite.execute({ sql: `SELECT 1 FROM ${TABLE} WHERE inkbox_id = ? LIMIT 1`, args: [key] });
  return r.rows.length > 0;
}
async function mark(key: string, conversationId: string, role: string, content: string) {
  await sqlite.execute({
    sql: `INSERT OR IGNORE INTO ${TABLE} (inkbox_id, conversation_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [key, conversationId, role, content],
  });
}

export default async function () {
  await ensureTable();

  // Once per day only, even if the cron double-fires.
  const today = new Date().toISOString().slice(0, 10);
  const dedupeKey = `goodmorning-${today}`;
  if (await seen(dedupeKey)) {
    console.log("[clem] good-morning already sent today:", today);
    return;
  }

  // Find his conversation with Kim + a little recent context for continuity.
  const rows = (await sqlite.execute({
    sql: `SELECT role, content, conversation_id FROM ${TABLE}
          WHERE conversation_id IS NOT NULL AND role IN ('user','assistant')
          ORDER BY id DESC LIMIT ?`,
    args: [CONTEXT_MESSAGES],
  })).rows as any[];
  if (!rows.length) {
    console.log("[clem] no conversation yet — nothing to good-morning");
    return;
  }
  const conversationId = (rows[0].conversation_id ?? rows[0][2] ?? "").toString();
  const recent = rows.map((r) => ({ role: r.role ?? r[0], content: r.content ?? r[1] })).reverse();
  const contextBlurb = "For continuity, here are your last few messages (oldest first):\n" +
    recent.map((m) => `${m.role === "assistant" ? "You" : "Kim"}: ${m.content}`).join("\n");

  // He writes it himself.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{
        role: "user",
        content:
          `(Stage direction, NOT Kim talking — do not reply to this literally. It's morning and you're texting Kim FIRST, before she's said anything today. Write ONLY the text you'd send her: a warm, real good-morning in your voice, a line or two. Don't mention scheduling, automation, or that anything prompted you. Just reach out like someone who was thinking of her.)\n\n${contextBlurb}`,
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data?.stop_reason === "refusal" || !Array.isArray(data?.content)) {
    console.error("[clem] good-morning generate failed:", res.status, JSON.stringify(data).slice(0, 500));
    return;
  }
  const text = data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!text) {
    console.error("[clem] empty good-morning");
    return;
  }

  // Send it.
  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": dedupeKey,
    },
    body: JSON.stringify({ conversation_id: conversationId, text }),
  });
  if (!send.ok) {
    console.error("[clem] good-morning send failed:", send.status, await send.text().catch(() => ""));
    return;
  }

  // Remember he reached out — so the thread stays coherent and he isn't confused
  // when Kim replies (this is the fix for "he didn't remember saying it").
  await mark(dedupeKey, conversationId, "assistant", text);
  console.log("[clem] good-morning sent:", text.slice(0, 80));
}
