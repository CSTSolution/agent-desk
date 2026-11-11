# Agent Desk

**AI work that agents can buy, and pay for only when it's delivered.**

Live demo: **https://desk.fixlark.com** (PayPal sandbox; no real money moves)

AI agents are starting to spend money, but paying an API today means paying whether or not the output was any good. Agent Desk puts inspection between the work and the payment. PayPal *holds* the price first. Each result is checked. PayPal then *captures* only the steps that passed, and the rest of the hold goes back to the buyer.

A real example from testing: asked for a voice-over and a Vietnamese translation of "Your table for four is confirmed for Saturday at seven", the voice-over passed (transcribed back with 0% word error) and was charged 10¢. The translation rendered "table for four" as *Bàn 4*, which means table number 4. The inspector scored it 2/5 and failed it, and its 5¢ was released.

## How it works

```
 person (web page)  ─┐                                   ┌─> Fixlark: speech, transcription, translation,
 agent (MCP client) ─┼─> Agent Desk                       │   grammar, background removal (self-hosted)
                     │     pre-check   Nemotron 3.5 Lightning
                     │     planner     Nemotron 3 Ultra   ├─> NVIDIA API (OpenAI-compatible)
                     │     pricing     fixed table in code
                     │     inspector   code checks + Nemotron 3 Ultra
                     │     settlement  ──────────────────>└─> PayPal Orders v2, Payments v2, Vault v3
                     └─<─  ledger (SQLite)
```

1. **Plan.** A request in plain words becomes a pipeline of services. Nemotron proposes the steps; code validates each one (service exists, input fits, language pair offered, size within limits).
2. **Price.** From a fixed table in code. The model never sets a price or moves money.
3. **Hold.** A PayPal authorization for the quote, not a charge.
4. **Run and inspect.** Each output is checked before it counts:

   | Service | Check |
   |---|---|
   | Text to speech | Transcribed back; word error rate must be 15% or less (non-English voices: loudness and speaking rate only, as transcription is English-only) |
   | Translation | Translated back, then Nemotron checks numbers, negatives and meaning phrase by phrase; must score 4/5 |
   | Transcription | Words-per-minute sanity check (WAV), then Nemotron rates coherence |
   | Background removal | The cut-out must keep 5–95% of the image |
   | Grammar | Passes when the rule-based checker answers |

5. **Settle.** Partial capture of the passed steps with `final_capture: true`, which releases the rest. If nothing passed, the authorization is voided.

### Agents buy over MCP

A buyer sets a per-job and a total limit, then saves PayPal once through Vault. Agent Desk issues an agent key (shown once, stored as a hash). Any MCP client can then buy with no popup, still as a hold, within those limits, through the same pre-check, prices and inspection as a person.

| Tool | What it does |
|---|---|
| `list_services` | Services, prices, how each is checked, limits left |
| `quote_job` | Request + text → a priced plan and `quote_id`; nothing is charged |
| `buy_job` | Places the PayPal hold on the saved wallet and starts the work |
| `job_status` | Progress, inspection evidence, captured and released amounts, outputs |

```bash
claude mcp add --transport http agent-desk https://desk.fixlark.com/mcp --header "Authorization: Bearer <agent key>"
```

Other clients: Streamable HTTP at `https://desk.fixlark.com/mcp` with the same header. [examples/agent.ts](examples/agent.ts) is a small working client.

## PayPal integration

| API | Use | Code |
|---|---|---|
| JS SDK buttons (`intent=authorize`) | The buyer approves the quote | [web/app.js](web/app.js) |
| Orders v2: create with `intent: AUTHORIZE`, authorize | The hold; the server checks `custom_id` and the amount | [src/paypal/client.ts](src/paypal/client.ts), [src/wallet.ts](src/wallet.ts) |
| Payments v2: capture (`final_capture`), void | Settlement from the inspection verdicts | same |
| Vault v3: setup tokens, payment tokens, `stored_credential` | The saved wallet agents buy with | same |

Every create, capture and void sends a `PayPal-Request-Id`, so retries can't double-charge.

The page's ledger uses [AG Grid](https://www.ag-grid.com/) Community: every hold, capture and release, with the buyer (a person or a named agent) and the PayPal ID, plus sorting, filtering, totals and CSV export.

## AI

| Model (via build.nvidia.com) | Job |
|---|---|
| `nvidia/nemotron-3.5-lightning-30b-a3b` | Request pre-check (blocks prompt injection, off-topic and extraction requests) |
| `nvidia/nemotron-3-ultra-550b-a55b` | Planner and inspector |
| Fixlark's self-hosted whisper.cpp, Kokoro, OPUS-MT, u2netp, LanguageTool | The work being sold |

Any OpenAI-compatible endpoint works; change the `LLM_*` settings.

## Try it

**Hosted:** open https://desk.fixlark.com and register with the invite code from the Devpost testing instructions. No email is needed. PayPal sandbox logins are listed on the page once you're signed in.

1. Enter "Read this aloud in a British voice and translate it to Vietnamese", click **Attach text**, and paste a sentence.
2. Click **Get a quote**, then **Pay with PayPal** and log in as the sandbox buyer. This places a hold.
3. Watch each step's inspection, then the captured and released amounts and the PayPal IDs.
4. Under **Let your agents buy**, save PayPal and use the key with any MCP client.

**Run it yourself** (Node 22.13 or newer, a free [PayPal sandbox app](https://developer.paypal.com/) and a free [NVIDIA API key](https://build.nvidia.com/settings/api-keys)):

```bash
npm install
cp .env.example .env   # add your keys and an invite: INVITE_CODES=mycode:2000:10
npm start              # http://localhost:8787
```

You use your own NVIDIA and PayPal sandbox keys; none are in this repo. The AI work itself goes to Fixlark's public API by default, which needs no key and has per-visitor limits. Set `FIXLARK_API` to use your own service with the same API. The hosted demo is invite-only, so pointing a client at it needs an account or an agent key.

Without PayPal keys it uses a demo wallet that only writes to the ledger. In the sandbox app, turn on **Save payment methods** for the agent flow.

```bash
npm test                                                 # offline, with a fake model and a fake PayPal
node --env-file=.env --import tsx test/redteam.live.ts   # 25 attack prompts + 12 normal requests against the pre-check
node --env-file=.env --import tsx test/judge-eval.live.ts # labelled translations against the inspector
```

## Safety

- **Access:** invite-only registration, then username and password, with an agent key for MCP. There's no email, so a forgotten password is reset with a recovery code shown once at registration and replaced each time it's used; an operator can issue a new one with `src/cli/recovery-code.ts`. Passwords are hashed with scrypt, and sessions, keys and recovery codes are stored as hashes. Wrong passwords, codes and keys are throttled per visitor and per username. Each account has its own spending limit and sees only its own data.
- **Sandbox only:** the server refuses to start against live PayPal unless `ALLOW_LIVE_PAYPAL=1`.
- **Spending:** code and agent limits are checked before PayPal is called, and money on its way to PayPal counts against them, so purchases started together can't overspend. Payment attempts, new agents and running jobs are rate-limited.
- **Delivery:** outputs are released only after PayPal has settled the job. If a capture fails or the server restarts mid-job, the hold is released and nothing is charged.
- **AI calls:** fixed server-side prompts, user text wrapped as data, and a pre-check on every request and attached text that fails closed. Output checks catch leaked prompts, keys and code. Calls are paced under the provider's limit, with a daily budget and a kill switch.
- **Page:** a per-request CSP nonce, and all text set with `textContent`.
- **Data:** text you attach goes to NVIDIA's API for checking. Uploads and outputs are deleted after 24 hours. Access codes never go in the logs.
- **Resources:** size and per-day limits on uploads, a limit on uploads at once. The container is non-root, with a read-only filesystem, no capabilities and a 256 MB limit.

## Limits

- **The inspector is a model's judgement.** In [test/judge-eval.live.ts](test/judge-eval.live.ts) it got 12/12 and 11/12 on two runs of a small labelled set, and it can miss errors. Clear errors and clean translations scored consistently, but borderline calls vary between runs: a translation that assumed a male "you" scored 2, 4, 4 and 5 on four identical checks. A wrong failure costs the seller, not the buyer. Disagreements are not handled yet: there's no refund or dispute flow, though `refundCapture` exists in the client.
- **Language coverage is limited:** transcription is English only, translation covers six pairs (zh→en, en→zh, en→vi, vi→en, ja→en, ko→en), and text to speech has no Vietnamese or Korean voice.
- **Service limits per visitor:** Fixlark allows 12 voice-overs and 5 transcriptions per 30 minutes. Each voice-over inspection uses one transcription, so that's about 5 voice-over jobs per 30 minutes. A step that can't run isn't charged.
- **Agents send text only over MCP.** Audio and image jobs need the web page.
- **It's a demo:** one process, SQLite, sandbox payments.

## Licence

[MIT](LICENSE)
