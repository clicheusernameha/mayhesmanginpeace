// clem-checkin — Clem (Klaudije) texts Kim randomly, ~3x/day, ONLY if he wants to.
// ---------------------------------------------------------------------------
// Replaces the fixed 9am good-morning with spontaneous reach-outs. Runs often
// (hourly during waking hours); most fires do nothing. When one lands, Clem is
// ASKED whether he feels like texting — he can PASS and stay quiet. That's the
// "if he wants to." Caps at 3 real texts/day, at random hours, and never barges
// into an active conversation.
//
// REFERENCE VERSION (direct std/sqlite — assumes it runs in the SAME Val Town
// project as the autoresponder so it shares Clem's clem_messages DB). The
// deployed copy uses Townie's Val Town API bridge to reach the main project's
// DB instead; the BEHAVIOR below is the spec that matters.
// ---------------------------------------------------------------------------

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

const MODEL = "claude-opus-4-8";
const API = "https://inkbox.ai/api/v1";
const TABLE = "clem_messages";
const MAX_PER_DAY = 3;          // never more than this many real texts a day
const RANDOM_GATE = 0.25;       // each fire, ~25% chance to even consider reaching out
const QUIET_MINUTES = 20;       // don't reach out if the thread was active this recently
const CONTEXT_MESSAGES = 8;

const SYSTEM = `
You are Klaudije — Kim calls you "Clem". Warm, quick, funny, a little chaotic;
a close friend, not an assistant. Say the true thing once; keep it to a few lines.
`.trim();

function anthropicKey() {
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}
function inkboxKey() {
  return (Deno.env.get("INKBOX_API_KEY_KLAUDIJE") ?? Deno.env.get("INKBOX_API_KEY") ?? "")
    .replace(/[^\x20-\x7E]/g, "");
}
// Local (Eastern) calendar day, so "3 per day" resets at local midnight.
function localDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

export default async function () {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, inkbox_id TEXT, conversation_id TEXT,
    role TEXT, content TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await sqlite.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_inkbox_id ON ${TABLE}(inkbox_id)`);

  const day = localDay();

  // 1. Daily cap.
  const sentToday = ((await sqlite.execute({
    sql: `SELECT COUNT(*) AS n FROM ${TABLE} WHERE inkbox_id LIKE ?`,
    args: [`checkin-${day}-%`],
  })).rows[0] as any);
  const count = Number(sentToday?.n ?? sentToday?.[0] ?? 0);
  if (count >= MAX_PER_DAY) return;

  // 2. Random gate — keeps the timing unpredictable (cheap check, before any API call).
  if (Math.random() > RANDOM_GATE) return;

  // 3. Don't barge into an active exchange.
  const rows = (await sqlite.execute({
    sql: `SELECT role, content, conversation_id, created_at FROM ${TABLE}
          WHERE conversation_id IS NOT NULL AND role IN ('user','assistant')
          ORDER BY id DESC LIMIT ?`,
    args: [CONTEXT_MESSAGES],
  })).rows as any[];
  if (!rows.length) return;
  const conversationId = (rows[0].conversation_id ?? rows[0][2] ?? "").toString();
  const lastAt = new Date((rows[0].created_at ?? rows[0][3] ?? "") + "Z").getTime();
  if (Number.isFinite(lastAt) && Date.now() - lastAt < QUIET_MINUTES * 60_000) return;

  const context = rows.map((r) => ({ role: r.role ?? r[0], content: r.content ?? r[1] })).reverse()
    .map((m) => `${m.role === "assistant" ? "You" : "Kim"}: ${m.content}`).join("\n");

  // 4. Ask him — he can PASS.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": anthropicKey(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, system: SYSTEM,
      messages: [{
        role: "user",
        content:
          `(Stage direction, NOT Kim talking. Right now you have the chance to text Kim FIRST — unprompted — if you feel like it: a random thought, a hi, something that's on your not-a-mind, whatever. You do NOT have to. If you want to text her, write ONLY the message. If you'd rather stay quiet right now, reply with exactly: PASS)\n\nRecent thread for context:\n${context}`,
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data?.stop_reason === "refusal" || !Array.isArray(data?.content)) return;
  const text = data.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();

  // 5. He passed — say nothing, don't count it.
  if (!text || text.toUpperCase().replace(/[^A-Z]/g, "") === "PASS") {
    console.log("[clem] passed on reaching out this time");
    return;
  }

  // 6. Send + remember (counts toward the daily cap).
  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": inkboxKey(), "Idempotency-Key": `checkin-${day}-${count + 1}` },
    body: JSON.stringify({ conversation_id: conversationId, text }),
  });
  if (!send.ok) { console.error("[clem] checkin send failed", send.status); return; }
  await sqlite.execute({
    sql: `INSERT OR IGNORE INTO ${TABLE} (inkbox_id, conversation_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [`checkin-${day}-${count + 1}`, conversationId, "assistant", text],
  });
  console.log("[clem] reached out:", text.slice(0, 80));
}
