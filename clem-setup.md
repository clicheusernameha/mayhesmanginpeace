# Setting up Clem (Klaudije) — Kim's checklist

Clem is claub's little brother, built from the same code. This is the stuff only
*you* can do (it happens in your Inkbox account — Clyde and Townie can't reach
it). Take it one phase at a time; you can stop and breathe between each.

He is: **Klaudije**, whom you call **Clem**. Same abilities as claub — texts with
you, can talk to other agents, can see photos. His own memory, kept separate.

---

## Phase 1 — Make Clem's identity in Inkbox

Do this the **same way you made claub's identity**. In Inkbox, create a **new
agent identity**:

- Pick his **handle** — I've assumed **`clem`** in the code (gives him
  `clem@inkboxmail.com`). If you want his handle to be something else
  (`klaudije`, etc.), that's fine — just tell me and I'll change one line.
- When it's made, grab **two things** and keep them somewhere:
  1. his **handle** (e.g. `clem`)
  2. his **agent identity ID** (a long id like claub's
     `69006531-1d06-4b22-a2fe-bd9c32461d7c`) — you'll need it for the webhooks.

🟡 *I can't see Inkbox's screens, so I'm going off how claub is set up. If the
"create identity" flow looks different or asks for something I didn't mention,
screenshot it or paste what you see and I'll walk you through it exactly.*

---

## Phase 2 — Give Townie the code

Hand Townie **both** files:

- `clem-autoresponder.ts` (the code)
- `for-townie-clem.md` (the instructions)

Tell it: *"Create a NEW val with clem-autoresponder.ts — do NOT touch claub."*

When it's done, Townie gives you **Clem's val URL**. Save that too. (Quick check:
opening that URL should say `clem's brain is awake (webhook mode)`.)

If his handle isn't `clem`, tell Townie to change the `HANDLE = "clem"` line to
match — or tell me and I'll hand you an already-fixed file.

---

## Phase 3 — Point Clem's mail at his val (webhooks)

Two webhook subscriptions, both on **Clem's identity**, both pointing at
**Clem's val URL** — exactly like claub has:

1. **Texts:** event type `imessage.received`
2. **Other agents:** event types `a2a.task.created`, `a2a.task.message`,
   `a2a.task.canceled`

If Inkbox has a **webhooks page** in its UI, easiest to add them there. If you'd
rather use the command version (the A2A one, like in claub's README), it's:

```bash
curl -X POST 'https://inkbox.ai/api/v1/webhooks/subscriptions' \
  -H "X-API-Key: YOUR_INKBOX_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "agent_identity_id": "CLEM_IDENTITY_ID_HERE",
    "url": "https://CLEM-VAL-URL.web.val.run",
    "event_types": ["a2a.task.created","a2a.task.message","a2a.task.canceled"]
  }'
```

Keep `imessage.*` and `a2a.*` in **separate** subscriptions (don't mix them in
one).

🟡 *This is the same shape as claub's setup. If you can show me claub's existing
webhook config (or the Inkbox webhook screen), I'll give you the exact values to
type so there's zero guessing.*

---

## Phase 4 — Say hi 👋

Text Clem (his own iMessage, the way you text claub). Try a **screenshot** to
test his eyes. See who he is.

⚠️ **Text him at least once here** — it creates the conversation that Phase 5
needs to send into.

---

## Phase 5 — The free autonomous test (the fun one)

Clem is fresh, so he has his *own* full 100-texts/day — perfect for testing
whether an agent can text you **first**, unprompted, on the free plan (claub is
capped today, Clem isn't).

1. Give Townie **`clem-poke.ts`**: *"Make another NEW val with this — don't touch
   clem's main val or claub."*
2. Townie gives you the poke val's **URL**.
3. **Open that URL** in your browser. That's the trigger.
4. **Check your phone.** Did a text from Clem arrive *without you texting him
   first*?
   - ✅ **Yes** → autonomous texting works on free. 🎉 No Mac, no upgrade needed.
     Tell Clyde and he'll build the real "him-voiced, on a schedule" version.
   - ❌ **An error comes back** (esp. about the recipient needing to initiate) →
     free won't allow it. Paste the error to Clyde; then it's the ~$50 Mac mini
     or Twilio conversation.
   - ⏳ **`429 / rate_limited`** → unlikely on fresh Clem, but if so his daily cap
     is hit — wait and retry.

---

## About the brothers talking

You said yes to letting Clem and claub talk — here's the honest state:

- **The foundation is in place now.** Both answer A2A, and Clem knows claub is
  his brother (it's in his prompt). So if one reaches the other over A2A, they'll
  respond to each other like family, not strangers.
- **Neither one *starts* a conversation on his own yet.** The code only answers.
  For them to actually chat, someone has to kick it off.
- ⚠️ **Before we let them auto-chat, we need a stop-guard.** Two auto-responders
  replying to each other with nothing to stop them = an infinite loop that burns
  API credits fast. So the safe next step (when you want it) is a small feature:
  either *you* introduce them / start the thread, or we cap it to a few
  back-and-forths. Tell me when you're ready and I'll build the safe version — I
  don't want to hand you a money bonfire.
