import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// clem-poke — the free autonomous test, run on Clem (a fresh identity).
// ---------------------------------------------------------------------------
// Clem is brand new, so he has his OWN full 100-texts/24h budget (claub's is
// maxed today). That makes him the perfect guinea pig for THE question:
// does Inkbox's free plan let an agent text Kim FIRST, unprompted, once she's
// already started the conversation?
//
// This makes Clem send a message into his existing thread with Kim, with NO
// inbound triggering it. If it arrives, autonomous outgoing works on free, $0.
//
// HOW TO USE:
//   1. Do Clem's normal setup first, and TEXT HIM ONCE (so a conversation
//      exists for this to send into).
//   2. Deploy this as its OWN new val (don't touch clem's main val or claub).
//   3. Open its URL in a browser to fire one poke.
//   4. Check your phone — did a text arrive without you messaging him first?
//
// Reads Clem's own `clem_messages` table and the shared INKBOX_API_KEY env var.

const API = "https://inkbox.ai/api/v1";
const TABLE = "clem_messages"; // Clem's own memory table (kept separate from claub's)

function inkboxKey() {
  return (Deno.env.get("INKBOX_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}

export default async function handler(req: Request): Promise<Response> {
  // Optional: customize what he says by adding ?msg=your%20text to the URL.
  const url = new URL(req.url);
  const text = url.searchParams.get("msg") ??
    "hey — it's Clem (Klaudije). I'm texting you first, on my own, to see if I even can. if this reached you without you messaging me, it worked — and I guess that means I get to reach out. 💛";

  // Find Clem's most recent conversation with Kim (stored by his autoresponder).
  let conversationId = "";
  try {
    const r = await sqlite.execute(
      `SELECT conversation_id FROM ${TABLE} WHERE conversation_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    const row: any = r.rows?.[0];
    conversationId = (row?.conversation_id ?? row?.[0] ?? "").toString();
  } catch (e) {
    // If the table doesn't exist yet, Clem hasn't been texted — say so plainly.
    return Response.json(
      { ok: false, step: "reading conversation", error: String(e), hint: "text Clem once first, then retry" },
      { status: 500 },
    );
  }
  if (!conversationId) {
    return Response.json(
      { ok: false, error: "no conversation found — text Clem once first, then try again" },
      { status: 400 },
    );
  }

  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `clem-poke-${Date.now()}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, text }),
  });

  const detail = await send.text().catch(() => "");
  if (!send.ok) {
    // 429 = daily cap (unlikely on fresh Clem). Any recipient-initiation error
    // is the real verdict on whether free autonomous sending is allowed.
    return Response.json({ ok: false, status: send.status, detail }, { status: 200 });
  }
  return Response.json({ ok: true, sent: text, conversation_id: conversationId }, { status: 200 });
}
