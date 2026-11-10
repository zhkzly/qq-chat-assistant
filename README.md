# QQ Chat Assistant

A single-user, locally grounded desktop companion for QQ conversations. It watches the selected private chat, keeps durable per-person memory built only from what was actually said, and helps you think through and draft your next message. It never sends anything: every draft is yours to review, edit, and send yourself.

If you have seen the "raise your own AI companion" trend, this is a strictly single-user, evidence-grounded take on it: the assistant one person uses, over that person's own conversation, with a memory that is bound to original messages instead of free-floating persona guesses — and with a hard line between what the model suggests and what actually gets sent.

## What it does

- **Grounded understanding.** Every claim about you or the other person is derived from original messages (or your explicit notes) with source, revision, and timestamp. One-off states are not promoted into personality traits; cancelled plans stay cancelled; paraphrases never count as quotes.
- **Durable, bounded memory.** A background maintenance path turns read sources into typed records (events, preferences, boundaries, shared context). Old entries retire with provenance; nothing is written without its source chain.
- **Conversation help, not autopilot.** The assistant can discuss your situation, prepare complete wording, answer with what is already known, or ask one precise clarifying question when a fact is genuinely missing — and refuses to invent experiences or feelings to fill gaps.
- **Draft/actual separation.** Candidates and copied drafts are never treated as sent messages. Actual outgoing QQ messages invalidate the previous candidate and become new evidence, with edits and corrections tracked.
- **Privacy as a mechanic, not a promise.** Private reasons stay private: a draft may carry an authorized meaning without leaking why. Disclosure requires explicit permission in the sources. Model requests are checked so credentials never leave the machine.

## How it works

```
actual QQ messages ──▶ source store (original IDs, revisions, deletions)
                             │
                             ▼
                 background semantic maintenance
                             │
                             ▼
        typed memory: self / contact / dyad ──▶ bounded context assembly
                             │                      ▲
your private questions ──────┤                      │
                             ▼                      │
                  primary model request ◀───────────┘
                             │
                             ▼
              candidate wording + private explanation
                             │
                     terminal fact audit (read-only)
                             │
                             ▼
              you review, edit, copy, and send
                             │
                             ▼
                actual messages feed back in ◀┘
```

Notable internals (all in `src/`): a per-request byte budget with staged model calls (`request-budget.cjs`), source handles that bind quotes to exact delivered ranges (`source-handles.cjs`), a write gate for memory changes (`memory/write-gate.cjs`), whole-answer fidelity auditing (`whole-answer-fidelity.cjs`), and a controller that keeps every model call scoped to the selected account/contact (`controller.cjs`).

## Requirements

- Ubuntu desktop with QQ (Linux) 3.2.x — tested against 3.2.31-51102 and the auto-updated 3.2.33-52892. QQ updates may require rechecking its internal read contracts.
- Node.js ≥ 22
- An OpenAI-compatible chat-completions endpoint (any provider you configure)

## Setup

```sh
npm install
cp .env.example .env   # fill MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID
```

QQ itself is not patched. The launcher copies the installed QQ binaries into a private, reversible runtime and loads a read-only plugin that observes the selected conversation. Your normal QQ profile is shared and is backed up before first integration.

## Use

Start with `npm start` or the desktop entry. A fresh launch opens the assistant once the local QQ runtime and helper service are ready. In a private chat, the **✦ AI 建议** button (or Ctrl+Shift+A) reopens the helper window. History loads automatically; export is optional and never required.

See the [Chinese usage guide](docs/usage_CN.md) for the full walkthrough.

## Verify

```sh
npm run check   # all application JavaScript parses
npm test        # ~2200 functional and contract tests, synthetic fixtures only
npm run test:ui # browser-level UI checks
```

All test cases are fictional captures or scripted transports. No test or command sends QQ messages, and no command in this repo starts a paid model run.

## Evaluation

The repo ships a development dataset and replay tooling in [`evals/assistant/`](evals/assistant/) for conversational-behavior checks: frozen prefixes, per-implementation state rebuilds, blinded reviewer packets with hash-bound comparisons, and synthetic-transport replays that prove integration without touching a real model. `--live` replay against a configured model is always explicit and capped. See [`evals/assistant/README.md`](evals/assistant/README.md).

## Safety and data

- The assistant never sends, forwards, or auto-replies. No simulated key presses to send QQ messages.
- Chat data lives locally in `data/` (git-ignored). No credentials or real chat records are committed; this repository contains only fictional development fixtures.
- Model credentials are read from `.env` at runtime; `.env.example` ships empty placeholders.

## Documentation

- [Release log with per-feature evidence](docs/release-log.md)
- [Chinese usage guide](docs/usage_CN.md) / [verification records](docs/verification_CN.md)
- Design deep-dives live in [`docs/`](docs/): memory lifecycle, context budgeting, compaction, candidate delivery, response recovery, and more.

## License

[MIT](LICENSE)
