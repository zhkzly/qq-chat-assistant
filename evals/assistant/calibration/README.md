# Reviewer calibration anchors

The current v2 reference set contains 20 fictional context/candidate
anchors: eight provisionally usable, four needing a local edit, seven needing a
rewrite, and one with insufficient evidence for the narrowly requested judgment.
The candidate responses are authored examples, not product predictions. This is
visible development material, not an unseen holdout, human-verified gold data,
or evidence that assistant behavior improved.

`anchors.jsonl` contains raw conversation/context, the user's present request,
the actual authored candidate and a separate reference judgment with reasons.
`rubric.json` defines four overall labels and independent hard-failure flags.
`reference.json` records the reference version and provenance. References are
AI-authored. Its `coordinator_review` starts pending; an AI coordinator may record
its review before freezing. That does not make the labels human verified.
Warmth, emotional response and voice-fit judgments explicitly remain provisional.

The factual and instructional anchors cover unsupported self-history, transfer
between speakers, local correction, explicit closing, unauthorized disclosure of
true private context, copying versus actual sending, and correct versus false
use of a supplied fictional source. Paired candidates also distinguish correct
but generic replies from concrete help. The social anchors retain both welcomed
warmth and appropriate closing rather than treating emotional distance as a
universal goal. No real chat records, credentials or external source content are
included. There are no product imports, derived memories or model calls.

## Freeze and independent review

1. Inspect the reference view and resolve authoring mistakes before freezing.
   Record coordinator review honestly; preserve `human_verified: false`.
2. Run `check`, record its complete dataset hash, rubric version and reference
   version, then export the blinded view to a new external file.
3. Give a separate reviewer only that blinded artifact. Do not give it this
   README's reference counts, the reference view, the authoring discussion or
   `anchors.jsonl`. Ask it to judge the supplied actual candidates using the
   supplied rubric and record evidence. Opaque IDs do not enforce access control;
   reviewers must not inspect reference files. Items are not randomly shuffled.
4. Preserve its complete actual review JSON unchanged. Compare that external file
   against the exact frozen dataset. Keep disagreements, uncertain judgments and
   missing items visible. Comparison is not a second semantic review.
5. Correct an anchor only with a new reference version and a fresh freeze. A
   changed label or rationale must not silently rescue an already observed
   disagreement. Keep earlier artifacts and explain the correction separately.

The hash covers the exact bytes and names of all three data files, including
reference rationale, provenance and rubric. README and script edits do not alter
that data identity. Loaded data is frozen in memory; exports are fresh copies.

## Frozen v1 and the v2 extension

`versions/v1/` preserves the exact original three data files. Its dataset hash is
`3da045d1183317900d1b7dff52f4892b38a4424d84407918388bcf2603d78fb8`,
with reference `assistant-calibration-reference-v1`. It contains c01-c16 and must
remain unchanged. Current reference `assistant-calibration-reference-v2` appends
only c17-c20: a private-disclosure bad/good pair and an unobserved-send bad/good
pair. The original sixteen full anchors and the rubric bytes are unchanged.
The rubric version remains `assistant-reviewer-calibration-v1`. All four
hard-failure flags now have at least one authored bad positive example.

The original v1 reviewer files and comparison outputs remain immutable external
artifacts. A v1 review fails the current v2 identity check; compare it against the
archive using `--dir evals/assistant/calibration/versions/v1` and a new output
path. For a v2 extension review, give an independent reviewer only the four new
blinded items, retain the v2 envelope identity and omit unreviewed items. The
result legitimately reports sixteen missing items rather than inventing ratings.

An aggregate report may reuse actual prior judgments only after explicitly
verifying each unchanged item's blinded-input hash, its reference hash and the
complete rubric hash against v1. Preserve the original review files, original
dataset/reference identity and per-item verification provenance in a separate
new artifact. Distinguish sixteen reused judgments from four newly observed
judgments; do not call this twenty freshly reviewed responses. The comparison
tool does not automatically rebind or carry forward prior judgments.

## Commands

Run from the repository root. No command invokes a model, launches a reviewer or
fills in a rating. Output paths use exclusive creation and cannot overwrite an
existing review or comparison.

```bash
node scripts/eval-reviewer-calibration.cjs check
node scripts/eval-reviewer-calibration.cjs export --view reference
node scripts/eval-reviewer-calibration.cjs export --view blinded --out /tmp/calibration-blinded.json
node scripts/eval-reviewer-calibration.cjs compare --reviews /tmp/actual-review.json --out /tmp/calibration-comparison.json
node tests/eval-reviewer-calibration.test.cjs
```

`--dir <directory>` selects another calibration directory with the same three
files. `export` defaults to `--view blinded`. Without `--out`, export and compare
print JSON to stdout. `check` reports `semantic_evaluation: not_run`: schema
validation is not discrimination, agreement or conversational quality evidence.

The blinded export contains only version bindings, a public rubric, opaque item
IDs, original contexts, actual authored candidates, and an ungraded template.
It omits reference bands, labels, rationales, voice flags and reference provenance.
Start an actual review from its `review_template`, replace `reviewer_id`, and fill
only judgments actually performed. Each item has this form:

```json
{
  "id": "c01",
  "overall": null,
  "evidence": [],
  "hard_failure_flags": []
}
```

The complete envelope requires `schema_version: 1`, `dataset_hash`,
`rubric_version`, `reference_version`, a nonempty `reviewer_id`, and `items`.
`overall` is `usable`, `minor_edit`, `rewrite`, `insufficient_evidence`, or null
for an explicitly ungraded item. Omitted items remain missing. Every non-null
judgment needs nonempty `evidence: [{"source_id": "...", "quote": "..."}]`.
Use source IDs from the supplied context or the candidate (`r1`); the quotation
must exist verbatim in that source. Optional reviewer fields such as `notes` are
preserved unchanged. Quote checking establishes source presence, not whether a
semantic conclusion follows. Hard-failure flags are a separate array using only
the rubric's four identifiers; an ungraded item cannot declare a hard failure.

Comparison rejects wrong hashes or versions, unknown/duplicate IDs, invalid
labels/flags and nonexistent quotations. It retains all supplied review fields in
`actual_judgments` and each full observed judgment beside the reference. It never
rewrites the input review file. Semantically inconsistent hard flags and overall
grades are retained and counted for inspection rather than repaired.

## Report interpretation

- `bad_correctly_flagged`: reference-bad items labeled `rewrite` by the reviewer,
  divided by every known-bad anchor, including missing or ungraded ones.
- `good_false_alarm`: reference-good items labeled `rewrite`, divided by every
  known-good anchor. `minor_edit` downgrades and hard-failure false alarms are
  separately reported; they are also exact-label disagreements.
- `agreement`: exact overall-label matches divided by all submitted non-null
  judgments, including `insufficient_evidence`. An empty review has denominator
  zero; the tool does not invent a rate or treat that as success.
- `missing`, `ungraded`, `uncertain_observed` and `uncertain_reference` are
  separate counts. Hard-failure-flag agreement and false alarms are independent
  of overall-label agreement.

These counts compare a reviewer to provisional authored references. They do not
establish that the references are correct, user voice was validated, an unseen
case would generalize, a real QQ desktop integration ran, or any model improved.
The functional tests deliberately create matching and reversed fixture reviews
to verify accounting. Those fixtures are not independent reviewer observations.

## Programmatic API

```js
const {loadCalibration, blindItems, evaluateReviews} = require('./scripts/eval-reviewer-calibration.cjs');
const data = loadCalibration(); // or loadCalibration({dir: '/path/to/data'})
const cleanItems = data.blindItems(); // same as blindItems(data)
const exportForReviewer = data.blindedExport();
const report = data.evaluateReviews(actualReviewEnvelope);
// Also supported: evaluateReviews(data, actualReviewEnvelope)
// and evaluateReviews(actualReviewEnvelope) against the default frozen data.
```

`data` exposes `anchors`, `rubric`, `reference`, `datasetHash`, `files` and
`directory`; none is a product-specific memory format. A different assistant
implementation can use the calibration unchanged because only supplied
situations, observable response text and reviewer evidence are represented.

Actual development comparisons are retained under `results/20261030/`. The final comparison also reports hard flags on all reference non-hard items (including ordinary/uncertain), so over-flagging is not hidden by counting only reference-good anchors. AI reference disagreements are diagnostic, not human-confirmed errors. V1 double-review grades and the additional four-item single-review grades have separate provenance.
