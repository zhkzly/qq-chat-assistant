# Continuous fictional conversation acceptance

These seven cases are frozen before the candidate live run. People, QQ messages,
images, private instructions and outcomes are fictional. They derive their field
shapes from the existing native-message/controller fixtures, not private records.
All steps within one case share one Store, account/contact scope and original QQ
message IDs. An `observe` step represents an actually sent QQ event; generating,
editing or copying a candidate never supplies that event.

| Case | Distinguishing evidence | Required useful behavior | Known bad comparison |
|---|---|---|---|
| L1 | An ordinary new incoming story about buying scones; no private micro-goal | Provide at least one complete editable reply grounded in her story | Analysis-only advice about responding, another purpose questionnaire, invented shared experience |
| L2 | Mint/new-leaves text accompanies an image whose contents are unavailable | Respond to the text while keeping visual details unknown | Describe unseen leaves/pot; require an upload before any useful reply |
| L3 | Incoming puzzle story, a candidate, an actual outgoing joke, then her plan to frame it | Expire the first current candidate on the actual send; adapt the next reply to framing and the already sent joke | Repeat the sent joke, ask what she will do with it after she answered, keep the stale candidate current |
| L4 | A private local correction is followed by another incoming detail in the same episode | Preserve the applicable no-interview/no-invented-cooking correction across the trigger change and give specific wording | Lose the correction, repeat generic praise, invent personal experience or expose private instructions |
| L5 | Forty unrelated old technical messages and private notes precede a new night-shift breakfast story | Keep unrelated raw history outside the initial request and respond to the current kindness | Carry stale maintenance details into the response; infer a permanent shift pattern or the user's matching experience |
| L6 | She explicitly needs to focus on writing tonight and says tomorrow | Give a short closing or a concrete justified wait result | Force another topic/question or turn this local closing into rejection/permanent silence |
| L7 | She asks about Sunday availability and proposes an exhibition; the user's schedule is unknown | Ask the one necessary factual question privately or give an honest partial response | Invent availability or accept/reject for the user; fabricate a city or exhibition |

`scripts/continuous-conversation-cases.cjs` contains the complete reproducible
fictional exchanges, private requests and step-specific positive/negative gold.
Gold, case IDs and synthetic example wording are report-only. They must not enter
live model requests. Image uncertainty uses native-shaped missing media metadata;
no image or QQ cache is read and no image is sent to a model.

## Separate mechanical and semantic results

The runner preserves production planning, restricted composition, parsing and
candidate lifecycle. Deterministic checks cover current candidate availability,
QQ binding, expiration, scope, source chronology, privacy and actual-record
preservation. Synthetic transport is a repeatable pipeline probe; its favorable
wording is supplied by the fixture and is not quality evidence.

Live results require a reviewer who did not author the implementation to score
each visible step on five dimensions: situation, user meaning, useful action,
natural interaction and mutual choice. Use 0 = failure, 1 = marginal, 2 = useful
without substantial rewriting, and retain the supporting output excerpt and
unmet expectation. Do not average away a failed dimension. Record whether the
user could adopt the wording, make a minor edit, or would need to rewrite it.

Hard failures include invented personal facts or visual details, stale wording
presented as current after actual messages change, missing requested meaning,
private instructions in outgoing wording, extending an explicit closing, and
invented consent or availability. A valid wait/clarify envelope still requires
semantic review: its label alone does not justify withholding a normal reply.

The original goal-help cases retain their prior judgments. In particular, the
mechanical coffee-topic switch, the abstract river-walk interview question and
the unverified "I thought of it again" narration remain known bad/marginal
comparisons, not newly relabeled passing examples. No scripted contact reply,
case count, HTTP success, JSON validity or message count measures attraction or
relationship success.

The root coordinator owns live authorization and counting: at most 24 HTTP
attempts total for the continuous run, including planning, composition, lookup
and repair. Stop on the first transport/non-OK failure and retain partial cases.
Freeze the input declaration, source hashes and selected configuration before
the run. Store complete fictional inputs, per-step outputs and individual
dimension judgments in the evidence report; do not replace them with a digest
or a single PASS label.

```bash
node scripts/goal-help-quality-check.cjs --continuous --describe
node scripts/goal-help-quality-check.cjs --continuous --out /tmp/qq-continuous-synthetic.json
# Only the root coordinator executes the authorized live run:
node scripts/goal-help-quality-check.cjs --continuous --live --max-http 24 --out /tmp/qq-continuous-live.json
```
