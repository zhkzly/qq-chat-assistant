# QQ Chat Assistant

A local Ubuntu desktop companion for normal QQ conversations. It reads the selected private chat, loads accessible history, and provides a persistent private assistant conversation for thinking through what to do, responding, sharing personal material and reviewing actual interaction. Optional drafts can be copied or filled into an unsent QQ input for the human to review and send.

The goal-led architecture separates source evidence, durable memory, current consultation work, concrete talking material, assistance methods, stage-specific context compilation and the current candidate session. Its goal is useful openings and natural continuation, including when the user has no fresh daily story. The design, cross-agent counterexamples and acceptance boundaries are tracked in [the refactor note](docs/relationship-assistant-refactor-note_CN.md); release evidence is recorded separately.

**Previously released baseline:** discussion compaction was merged into `main` and loaded into the existing native helper after a service-only refresh; QQ was not restarted. The goal-led companion includes bounded current-topic direction, self/contact/dyad memory, source-bound feedback and optional manual drafts. Long private discussions can be semantically compacted with the authorized primary model, stored in a validated local cache, and reopened by original turn/candidate references. The text budgets remain 48,000 bytes for the selected payload and 64,000 bytes for the complete serialized UTF-8 request, not tokens. See [automatic discussion compaction](docs/discussion-compaction_CN.md) and [its release evidence](docs/discussion-compaction-evidence.json); [direction release evidence](docs/conversation-direction-evidence.json) and [prior relationship evidence](docs/relationship-implementation-evidence.json) remain historical records of earlier native releases.

**Historical recovery release:** invalid structured discussion, review or reply output can use the existing single repair to deliver fresh private advice without applying failed bookkeeping proposals. Draft preparation remains strict; a final draft can recover one expression only from its already restricted input. The implementation passes 349 functional and 31 current browser checks. A synthetic Claude replay delivered a constrained draft and a correct later review, while its initial private advice still had unsupported situational assumptions and overly personal teasing. No model or destination switch is made; the inspected configuration remains `claude-sonnet-4-6` through the local port-8317 proxy. See [recovery behavior and known semantic failures](docs/response-recovery_CN.md) and [recovery evidence](docs/response-recovery-evidence.json). Readable output and valid review receipts do not establish correct interpretation or relationship progress.

Goal-directed help distinguishes automatic observation, manual suggestions and private consultation, with one fixed observation clock across planning, repair and restricted wording. It can help the user respond, learn, share real material, consider an activity, express interest or pause according to the present request. See [the design and research boundaries](docs/goal-directed-help-design_CN.md) and [predeclared quality scenarios](docs/goal-help-quality-scenarios.md); functional checks do not establish wording quality or romantic outcomes.

Current reply candidates appear before private consultation, with their QQ binding and freshness. Actual outgoing messages withdraw the current candidate while preserving edited drafts. Context assembly starts from the bounded current exchange and applicable private intent; older evidence stays local and is retrieved through the existing lookup interface. See [selective context and candidate delivery](docs/lazy-candidates-design_CN.md). `npm run test:candidates-ui` checks a continuous fictional controller/browser flow; it does not send QQ messages.

Users can discuss goals and recent experiences naturally, continue a previous idea into a draft without copying it again, correct or forget context, and inspect what was used. Explicit user intent controls lasting goals and disclosure; uncertain operations show a concrete proposal. The assistant never sends QQ messages. See [context behavior and limits](docs/context-management_CN.md).

The window opens into current candidates and private discussion with a fixed composer. The two topic-opening actions preserve unsent private input; Send or Ctrl+Enter submits that input. A user consultation can preempt automatic generation, while new edits remain separate from an in-flight user request. The help menu selects discussion, draft or review without submitting. QQ history and relationship memory have separate tabs; API configuration lives in Settings, and adopting an expression opens an editable draft dialog. The [earlier interface verification record](docs/ui-clarity-evidence.json) is historical evidence of an earlier release.

## Use

Start `bash scripts/launch.sh` or the **QQ 聊天助手** desktop entry. A fresh launch opens the assistant after the local QQ runtime and helper service are ready; log in normally if QQ asks. **✦ AI 建议** in a private chat or **Ctrl+Shift+A** in QQ reopens the same helper window. If ordinary QQ is already running without the assistant, save any unsent text and exit QQ from its menu before starting the assistant entry. The launcher displays an error and never closes ordinary QQ automatically. Enter a friend's QQ number if the current window cannot be identified. History loads automatically; export is optional. See [Chinese usage guide](docs/usage_CN.md).

The installed QQ binaries were copied into a private reversible runtime; `/opt/QQ` was not patched. The original profile is shared with normal QQ and was backed up before integration. The installed base is 3.2.31-51102; the tested auto-updated code is 3.2.33-52892 on Electron 40. QQ updates may require rechecking its internal read contracts.

## Verify

```sh
npm test
npm run test:ui
npm run test:assistant-ui
npm run test:goal-replay
npm run test:relationship-goal
npm run test:experience-browser
npm run test:direction-ui
npm run test:direction-goal
npm run test:mode-ui
npm run test:compaction-goal
npm run test:recovery-ui
npm run test:recovery-goal
npm run check
npm run diagnose
```

Tests use synthetic messages. Browser screenshots are labeled synthetic. Real history and credentials are under ignored, private `data/`; do not share that directory. The documentation archive excludes it.

Reusable fictional development cases and their review criteria are in [evals/assistant](evals/assistant/README.md). Run `npm run eval:check` for offline validation and `npm run eval:list` to select cases. The checker does not run a model or grade conversational quality.

Mutation checks are optional when useful, not a normal prerequisite. Browser checks use isolated temporary Chrome profiles; their results do not prove native integration or relationship outcomes.

## Architecture

`plugin/` integrates the QQ UI and enforces a two-route read-only QQ IPC allowlist. `src/` contains the scoped SQLite store, model projection, consent gate and loopback server. `ui/` is the companion window. The native adapter observes emitted message updates; outgoing records are accepted only after successful sending by QQ. Copying and draft filling never create a sent record. Draft filling checks the live private peer and account, preserves existing text, and exposes no send operation.

Compaction, ordinary assistance, format repair, transport retries and restricted drafting share the default four-HTTP-attempt budget per help task. Cache reuse avoids another compaction call. Known Claude 4.6 adapters use named result envelopes as data, never executable tools. Invalid discussion/review/reply output now uses the existing repair for fresh natural text; queued bookkeeping proposals are discarded, while genuine earlier action receipts remain. Strict draft preparation still validates sources and disclosure; only the subsequent restricted draft can recover natural text. Nested stringified fields are not silently accepted. Pending private intent retains recent original sources and lookup references until a source-version-bound review receipt is applied, independently of short run retention. Earlier malformed-envelope and failed JSON-carrier repairs remain in the evidence. These mechanisms do not guarantee provider compatibility, faithful interpretation, natural wording or romantic outcomes.

An explicit consent record binds model access to the selected QQ account/contact, model and API base URL. Closing the helper pauses automatic model generation. No arbitrary QQ dispatch or send API is exposed.

The historical recovery release was merged into main and activated in the then-running helper (source `7d00a63`, prompt `relationship-context-2026-10-13.2`). A service-only refresh preserved QQ, the selected scope and all measured unsent inputs. The original failed private question completed through natural-text recovery in two HTTP attempts; bookkeeping remained deferred. See the [native recovery evidence](docs/response-recovery-evidence.json).
