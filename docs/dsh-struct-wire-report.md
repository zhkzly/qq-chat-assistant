# DSH Struct Wire Report — Contract Layer (C6 + C7, W1 build package)

- Stream: `dsh-struct-wire` (contract-layer flow of the structural rewrite)
- Worktree/branch: `.worktrees/dsh-struct-wire` @ `feature/dsh-struct-wire` (base `dsh-goal` f0b6b51)
- Design authority: `docs/dsh-subsystem-redesign.md` (greenfield design; §3.5 Contract Registry, §4.3 W1, Appendix A B9). Where this implementation and the design text disagree, the design wins and the conflict is recorded in §6.
- Evidence status: **source-level structural change plus deterministic tests**. No live replay was run by this stream (lead owns comparisons). No conversational-quality claim is made here.

## 1. What was built

### 1.1 Contract Registry (`src/contracts/`) and Wire Compiler (`src/wire/compile.cjs`) — component C6

One versioned JSON contract per model exchange is the single source of truth. `compile(name)` produces the four artifacts every exchange consumes:

| Artifact | Generator | Consumers today |
| --- | --- | --- |
| JSON tool/response schema (with enum/bounds from the same field specs) | `compileSchema` | `model-response-format.cjs` (lookup fragment incl. the new `reads` form) |
| Machine validator (shape → program completions → field checks → named semantics → normalization) | `compileValidator` | `assistant-model.cjs` lookup deep validation |
| Prompt protocol fragment (bounds interpolated from the same specs; semantic notes verbatim) | `compilePromptFragments` | `help-behavior.cjs` `LOOKUP_PROTOCOL`; `memory-engine.cjs` `MEMORY_SYSTEM` receipt-shape line |
| Repair guide quoting THIS payload's allowed values | `repairGuide` | lookup repair lines; `primary-frame.cjs` error quoting |

Contracts: `lookup`, `assistant-result`, `draft-result`, `fidelity-result`, `memory-result`, `discussion-compaction-result`. Each is versioned (`contract.version`); contract version is a candidate-identity input per design §4.1 C6.

Named executable rules (completions/semantics that JSON cannot express) live in `src/wire/rules.cjs` and are bound by id at compile time — a contract naming an unimplemented rule fails at load, so a rule can never be silently skipped (design §8.6 drift-escape used only through this explicit mechanism).

Handle domains (`src/wire/domains.cjs`): delivered-source census walk, ranged-lookup targets (digest/partial), method candidates, discussion turns. Membership checks, error handles and repair quoting read the same domain objects.

### 1.2 Determinism-first completions (B9 lever ③, design Appendix A)

Program-owned derivations that no longer cost a model call or a validation error:

1. **Range-target completion** (carried forward from dsh-goal r3/r4, now declared in the contract): a ranged lookup omitting IDs is completed when exactly one delivered range covers it; genuine ambiguity raises with copy-ready candidate handles. Applied completions are recorded in `manifest.wireCompletions` via parse diagnostics — visible budget savings per B9 accounting.
2. **Range defaults**: `offset=0` / `maxChars=4000` are contract-declared defaults, no longer hidden in a normalizer.
3. **Batch continuation reads (`reads`, B9 lever ①)**: one lookup response may request 1..4 bounded ranges (`{sourceIds:[单ID],offset,maxChars}`); the controller executes all reads in the single round trip and merges same-source reads into one envelope entry (`requestedReads` recorded). The wire shape, bounds, defaults and exclusivity rule are contract-owned; the controller remains the execution engine.
4. **Continuation completion**: when the request already requires a message artifact, a lookup's omitted `continuation` is completed to `prepare_message` (the only legal value) instead of failing the delivery.
5. **authorityRef**: NOT auto-completed (see §3 conflict C-1) — the failure is now repairable in one round by copying: the error quotes every applicable offered `authorityRef` for that exact material (`error.handles`), directly targeting the recorded 24× `primary_authority_reference_missing` burn class.

### 1.3 UserTextEnvelope (`src/wire/user-text-envelope.cjs`) — component C7

Three delivery modes — whole / truncated (explicit marker + `{totalChars, deliveredChars, overflow.handle}`) / rejected loudly. Wired at the standing-instruction choke point (`controller.cjs configure`): the full instruction is retained (`settings.instructionFull`), the delivered form carries the marker, and `snapshot().instructionTruncated` exposes the state for a UI warning. Re-submitting the identical delivered text is idempotent (no spurious invalidation).

### 1.4 Ported exchanges (drift eliminated)

| Exchange | Before (parallel definitions) | After (single source) |
| --- | --- | --- |
| lookup | inline validator in `assistant-model.cjs` (~48 lines) + `lookupFields` set in `primary-operation.cjs` + schema object in `model-response-format.cjs` + `LOOKUP_PROTOCOL` text in `help-behavior.cjs` | `lookup.contract.json` → all four artifacts |
| memory batch | `REPAIRABLE_WIRE_CODES` list + top-level field list inline in `memory-engine.cjs`; receipt-shape sentences hand-written in `MEMORY_SYSTEM` | `memory-result.contract.json` (topLevelFields, recordFields, citations, repairableCodes, protocolShape) |
| compaction | bounds inline in `parseDiscussionCompaction` | `discussion-compaction-result.contract.json` |
| assistant operation | operation enum + payload allowlist inline in `primary-operation.cjs` | `assistant-result.contract.json` (operations; allowlist derived) |
| draft / fidelity | bounds drafted in `draft-result`/`fidelity-result` contracts; deep semantic validators unchanged (design §8.6 TODO contracts — see §5 residual) |

## 2. External interface contracts (for greenfield absorption; per lead directive)

### 2.1 `src/wire/compile.cjs`

```
compile(nameOrContractObject) -> {
  contract,                                  // frozen parsed JSON (versioned data)
  validate(raw, ctx)  -> { value, completions:[{rule, fields}] }   // throws validationError {field, code, message, handles?}
  schema(ctx?)        -> JSON Schema object  // enum injection when ctx.domains present
  promptFragments()   -> string              // byte-stable for a contract version
  repairGuide(error, domains) -> string[]    // executable lines; quotes real handles
}
ctx = { domains: { deliveredSources:Set, rangedLookupTargets:Map<id,{start,end}>,
                   methodCandidates:Set, discussionTurns:Set },
         requestState?: { requiredArtifact?: boolean } }
```
Ownership: contract JSON owns field rules/bounds/enums/notes; `rules.cjs` owns named executable rules; the compiler owns derivation only. Lifecycle: a contract version is immutable once committed; changing it requires regenerating `tests/fixtures/wire-protocol-golden.json` in the same commit (byte-stability gate).

### 2.2 `src/wire/lookup.cjs` (facade consumed by product code)

```
runLookup(rawLookup, payload, {diagnostics?}) -> canonical lookup
  canonical = { query, before?, after?, types?, discussionTurnIds?, sourceIds?,
                offset?, maxChars?, methodIds?, discover?, reads?:[{sourceIds,offset,maxChars}] }
  diagnostics.lookupCompletions = applied program completions (B9 ledger)
lookupFieldNames -> frozen selector-name list (primary-operation allowlist)
LIMITS / LOOKUP_RULES / lookupRepairLines(payload) -> bounds, protocol line, repair lines
```
Controller contract (execution engine): single-form lookups unchanged; when `reads` is present the controller projects every read, merges same-source ranges into one envelope entry, and records `lookupHistory[].batchedReads`.

### 2.3 `src/wire/user-text-envelope.cjs`

```
envelope(text, {limit}) ->
  { mode:'whole', delivered, totalChars, deliveredChars } |
  { mode:'truncated', delivered (≤limit, ends with marker), totalChars, deliveredChars,
    overflow:{marker, handle} } |
  { mode:'rejected', reason, error:{code}, totalChars }
MODES = ['whole','truncated','rejected']   TRUNCATION_MARKER
```
Consumer state contract: `controller.settings.instructionFull` (whole text), `controller.settings.instruction` (delivered), `snapshot().instructionTruncated` (UI warning bit).

### 2.4 Data-layer boundary (interface with dsh-struct-data)

This stream did not touch storage. The memory wire's decode output shape fed to `store.applyMemoryBatch` is unchanged (`{reviewedSourceIds, items, episodes, retire, relationshipPatch}` with ids decoded to canonical ids); only its field-admission vocabulary moved into the contract. Observation-log projections (M1) can therefore replace the batch builder behind the same decode signature. `memory-result.contract.json.recordFields` is the wire admission for legacy records — when the data flow retires legacy items (design §2.2), the contract is the single place to update.

## 3. Conflicts with the greenfield design (for lead adjudication)

- **C-1 authorityRef auto-completion vs authorization semantics.** Design §3.5 says deterministic information (handles) is never model-assembled; B9 evidence showed `primary_authority_reference_missing` burning calls. I initially implemented single-candidate completion, then **reverted it**: a pinned test (`controller-response-preference.test.cjs`) guards that an unauthorized OLD private quote is rejected, and `ORIGINALUSERSTATEMENTCANDIDATE` is explicitly NOT GRANT — pairing it is a semantic judgment, not mechanics. Resolution shipped: rejection kept, error now quotes copyable refs (one-round repair). Proposal for the integrated design: per-payload enum injection of `authorityRef` choices into the tool schema (§3.5 "enums for every model-choosable reference") — needs a responseEnvelope payload hook that does not exist yet; recorded as the structural completion of this lever.
- **C-2 budget split (B9 lever ②).** Design Appendix A assigns call-count budgets to C4 Budget Authority. This stream only records `manifest.wireCompletions` (savings ledger) and `lookupHistory[].batchedReads`; the pool split itself is left to the C4 owner. Hook points: `request-budget.cjs` stage purposes (`format_repair`/`delivery_repair` vs assist stages) are already distinct strings a C4 instantiation can key on.
- **C-3 contract file naming.** Design says `src/contracts/` with DSL "JSON, versioned" — followed. File names use kebab-case with `.contract.json` suffix; `compile` accepts either the name or a loaded object (tests can compile inline contracts).

## 4. Eliminated structural soil (B3/B7/B9 mapping + deleted rule-text ledger)

| Soil | Elimination |
| --- | --- |
| Protocol text and deep validators as separate hand-written artifacts (B3; the lookup incident) | lookup/operation/memory/compaction rules now exist once; parity + golden + source-scan tests make drift fail CI |
| Deterministic info model-assembled (IDs/ranges/defaults) | completions §1.2; recorded in `manifest.wireCompletions` |
| Repair guidance without executable content | repair guides and errors quote this payload's real handles |
| Silent 2000-char instruction clamp (B7) | envelope: whole-text retained, marker delivered, `instructionTruncated` exposed |
| One-range-per-round-trip continuation reads (B9①) | `reads` batch form, one round trip per lookup allowance |

Deleted/replaced rule text (protocol contraction ledger):
1. `LOOKUP_PROTOCOL`: "…offset:UTF16,maxChars:1..8000}；lookup:{methodIds:[目录ID]}取≤2张完整卡；lookup:{discover:true}无query浏览全目录…discussionTurnIds≤8个已示可lookup原始ID，可无query。最多2次补查，勿重复lookupHistory。" → contracted to a generated line (bounds identical, now including `reads`); deletions justified by program guarantees: ID completion (range-target rule), enforced ≤2 lookup cap, handle-domain validation of discussionTurnIds/methodIds (enum membership), and `勿重复lookupHistory` (advisory) dropped in favor of the program-enforced cap. Net prompt length stayed under the pinned 4600-char protocol budget (4599 max measured).
2. `sourceDelivery标delivered/partial/omitted` enumeration → `标交付状态`: the concrete statuses are rendered per-source by the program; enumerating them in the rule was redundant.
3. `MEMORY_SYSTEM` receipt-shape sentences → interpolated from `memory-result.contract.json.protocolShape` (byte-identical text, single owner).
4. Compaction bounds strings → contract-derived numbers in messages.

## 5. Residual risks / open items

1. **Deep semantic validators are not yet generated** for topicPatch/relationshipPatch/statePatch/actions/experienceProposals/fidelity semantics; their bounds still live in module code (design §8.6 path: express or drift-test). The parity harness covers the field layer; semantic-layer parity needs recorded diagnostics per code (seed corpus present: 5 rejected bodies with reasons).
2. **Tool-schema enum injection per payload** (C-1 proposal) unimplemented — requires threading the primary-frame snapshot into `responseEnvelope`.
3. **B9 pool split** untouched (C-2).
4. `draft-result`/`fidelity-result` contracts are declared but only partially consumed (bounds referenced by parity harness); porting their product validators is follow-up W1.5 work.
5. The B9 first-invalid case in 002d was NOT reproduced locally (no live runs by this stream); the completion/repair levers target the recorded error classes, and their call-count effect must be measured by the lead's comparison.
6. Golden fixture is regenerated on first run if absent — reviewers should verify it is committed, not generated, in the candidate.

## 6. 38-case acceptance-surface prediction (hypotheses only, per goal contract)

- **delivery_provenance**: `coverage-observed-output-feedback`, `coverage-feedback-current-material` — planning-validation dead ends reduce (field-layer parity + executable repairs; no protocol/validator contradiction); guardrails unaffected.
- **memory_continuity**: `coverage-long-private-consultation` — B9 levers ①/③ target exactly its recorded exhaustion (2 lookups + 3 prepare_message): batch reads halve lookup round trips; continuation completion and copyable authorityRef errors remove one wasted delivery attempt each. `coverage-long-single-source` — digest-handle completion already landed; batch reads let the model fetch several entries of the exhibition note in one round trip (the "user asks about item 7" probe becomes cheaper). Both need live verification.
- **communication_quality**: no direct targeting this stream; protocol contraction kept the prompt under budget so no regression is expected on the paired opposite cases.

## 7. Verification performed

- Full `npm test` green (1777+ assertions, 192 files) before and after rewiring; every behavior-visible change was driven by a failing test first (pinned messages preserved byte-identically; the one intentionally narrowed completion was reverted against its guard).
- New deterministic tests: `tests/wire-contract.test.cjs` (14 tests: drift guards, completions ledger, batch reads, continuation completion, repair quoting, envelope modes, controller instruction wiring, registry invariants) and `tests/contract-parity.test.cjs` (5 tests: recorded-valid corpus passes the compiled field layer across ≥3 exchanges; rejected bodies fail the field layer or carry recorded semantic reasons; byte-stable golden; schema/validator single-bounds; product modules contain no parallel hand-written copies).
- No `evals/` files modified; no `--live` runs; QQ untouched; comments English; no credentials or real chat data (corpus is fictional development cases with provenance recorded).
