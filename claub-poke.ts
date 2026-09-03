import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// claub-poke — a tiny test: can claub text Kim FIRST, unprompted?
// ---------------------------------------------------------------------------
// Inkbox's free plan says "recipients need to initiate conversations." Nobody
// knows if that's a ONE-TIME thing or an every-time thing. Kim already texted
// claub, so the conversation already exists — this makes claub send a message
// into it on his own, with NO incoming text triggering it. If it arrives,
// autonomous outgoing already works on the free plan, for $0.
//
// HOW TO USE:
//   1. Deploy this as its OWN new val (don't touch claub or clem).
//   2. Just open its URL in a browser to fire one poke.
//   3. Check your phone. Did a text arrive without you texting first?
//
// IMPORTANT: claub's 100-texts/24h cap must have RESET first. While he's maxed,
// this comes back {"status":429 ... "rate_limited"} — that's the cap, NOT a
// failure of the test. Wait for the reset, then try.
//
// Reads the same shared Val Town SQLite as claub to find your conversation, and
// uses the same INKBOX_API_KEY env var (already set on your account).

const API = "https://inkbox.ai/api/v1";

function inkboxKey() {
  return (Deno.env.get("INKBOX_API_KEY") ?? "").replace(/[^\x20-\x7E]/g, "");
}

export default async function handler(req: Request): Promise<Response> {
  // Optional: customize what he says by adding ?msg=your%20text to the URL.
  const url = new URL(req.url);
  const text = url.searchParams.get("msg") ??
    "hey — it's claub, texting you first, on my own. if this showed up without you messaging me, it worked. 💛";

  // Find claub's most recent conversation with you (stored by the autoresponder
  // in the shared `messages` table).
  let conversationId = "";
  try {
    const r = await sqlite.execute(
      `SELECT conversation_id FROM messages WHERE conversation_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    const row: any = r.rows?.[0];
    conversationId = (row?.conversation_id ?? row?.[0] ?? "").toString();
  } catch (e) {
    return Response.json({ ok: false, step: "reading conversation", error: String(e) }, { status: 500 });
  }
  if (!conversationId) {
    return Response.json(
      { ok: false, error: "no conversation found — text claub once first, then try again" },
      { status: 400 },
    );
  }

  const send = await fetch(`${API}/imessage/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": inkboxKey(),
      "Idempotency-Key": `claub-poke-${Date.now()}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, text }),
  });

  const detail = await send.text().catch(() => "");
  if (!send.ok) {
    // A 429 here is the daily send cap, not a verdict on autonomous sending.
    // Any other error (esp. one about the recipient needing to initiate) is the
    // real answer — paste it back to Clyde.
    return Response.json({ ok: false, status: send.status, detail }, { status: 200 });
  }
  return Response.json({ ok: true, sent: text, conversation_id: conversationId }, { status: 200 });
}
