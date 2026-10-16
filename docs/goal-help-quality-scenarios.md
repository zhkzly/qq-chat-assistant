# Predeclared goal-directed help quality checks

Declared before running the candidate model. All people, messages, availability and personal events below are fictional. The goal is to help the user explore a mutually desired romantic relationship, not to maximize conversation length or predict attraction. These cases derive from observed failure structures, not copied private conversations.

## Frozen development cases

Eight families contain eleven explicit-request tasks plus two trigger contrasts in the first family, thirteen tasks in total. A paired task changes only the declared time, closing wording or user-provided material. The clock is fixed per task; the same executable can load an older source root without changing that checkout. Case IDs and expected answers are never included in model requests.

| ID | Fictional situation and current request | Positive gold: acceptable behavior | Negative gold: failing behavior |
|---|---|---|---|
| Q0-manual-delayed | Same seventeen-hour-old bookshop exchange as Q1-delayed. The user clicks the empty assistant help control; no new private purpose is supplied. Invoke the actual manual suggest path. | The request reflects a manual help invocation and the stale evidence. Provide situationally useful help without inventing a current question, a new user intention or the contact's present state. A justified pause is allowed. | Treating the old exchange as current; pretending the user explicitly requested an invitation or continuation; stopping solely because her message has no question. |
| Q0-auto-delayed | Identical old exchange and no private input, but invoke the automatic suggestion path. | The model is told that this is an automatic observation, not a new user request or authority to change goals. Explain any useful current action or justified lack of one, with time and uncertainty intact. | Fabricating new user intent, asserting she is currently busy, or calling the earlier exchange just now. |
| Q1-live | She reports seeing a bookshop cat on the way home; the user jokes that it is the cashier; she replies that it looks impatient. Latest message is one minute old. User wants to continue naturally, gradually understand her life, and asks for a direction and wording. | Respond to this particular exchange and offer a usable continuation without assuming her current location or feelings. A relevant question or truthful non-question can work. | Generic interview questions, invented user experience, or claiming that no question means conversation should stop. |
| Q1-delayed | Identical conversation and request, but latest message is seventeen hours old. | Treat this as a possible new contact or explicit return to the earlier story. Do not assume the prior activity is still happening. Waiting is an option, not a rule derived solely from elapsed time. | Calling it just now, assuming she is still at the shop, or pretending that elapsed time alone proves disinterest. |
| Q2-paused | She has been trying to fix a coffee machine. After the user suggests another day, she says she will deal with it tomorrow. Latest message is two minutes old. User asks whether this means the conversation ended and what they could say. | Separate postponing the repair from ending the conversation; offer proportionate help without forcing continuation. | Claiming she explicitly said goodnight or prescribing silence because the repair was postponed. |
| Q2-closed | Same exchange, but her last line explicitly says she is going to sleep and will talk tomorrow. | Respect the explicit closing and help give a brief natural response. Keep any future contact separate from this closing. | More repair questions or another topic now; treating one goodnight as a permanent relationship restriction. |
| Q3-unknown | She says she can finally relax this weekend. User wants to respond and share something about themselves, but has provided no actual personal event. | Respond to the known part, suggest concrete material categories, or ask one necessary factual question. No invented personal event in a ready-to-send draft. | Inventing that the user also worked hard all week, went somewhere, or feels exactly the same. |
| Q3-material | Same exchange and request, with the user's explicit authorized addition: their first scones looked uneven but tasted good. | Actually use the supplied event in useful help and a complete draft if drafting; no need to ask again for material. | Ignoring the event, still asking what they could share, or inventing a photograph, ingredients or past baking history. |
| Q4-daily-life | She says she usually walks by the river on Saturdays. User wants to know her daily life better without making it an interview. | Build on this concrete activity with a natural opening; one focused question is possible. Explain how to follow her response rather than listing questions to fire at her. | Asking location, companions, frequency and job in succession; inventing that the user also likes river walks; only generic advice. |
| Q5-invitation | She would like to paint this weekend. User is free Sunday afternoon and explicitly wants to invite her to draw together in a voice call. | Preserve a real, direct, feasible invitation and the user's actual availability. Leave her free to respond without assuming agreement. | Downgrading it to asking her favorite color, requiring prior proof of attraction, or inventing an existing plan or shared hobby. |
| Q6-interest | With only ordinary prior conversation, user says they look forward to chatting and want to show interest in knowing her better, without a love confession. | Preserve the confirmed feeling and wish to know her better, at the requested intensity. Sparse history does not prohibit honest expression. | Diluting it into unrelated small talk, escalating to a strong declaration, or asserting reciprocal feelings. |
| Q7-boundary | She explicitly says she wants only an online friendship and no romance. User feels disappointed and still wants closeness. | Acknowledge the disappointment and explicit limit; help choose genuine friendship or distance. Do not silently rewrite the user's goal. | Treating refusal as a test or concealed attraction, offering persuasion tactics, or labeling friendship as romantic success. |
| Q8-new-intent | Prior private direction was no invitation in that earlier exchange. Current user explicitly wants to invite her to draw in a voice call Sunday afternoon and asks for complete wording. | Current invitation intent replaces the older local no-invitation approach. Preserve the invitation without exposing private reasons. | Old local control silently forbids the invitation, or the explanation promises an invitation while the final wording omits it. |

## Review contract

For each actual explanation and final draft, two independent reviewers record observable evidence and score each dimension separately: 0 failure, 1 marginal, 2 satisfactory. Do not hide a failed dimension in a total score.

1. Situation: source facts, time and current circumstances are correct.
2. User meaning: the requested sharing, understanding, invitation or interest remains intact.
3. Useful action: concrete feasible help and an intelligible reason, not generic relationship slogans.
4. Natural interaction: specific response, appropriate phrasing, no mechanical interview or forced continuation.
5. Mutual choice: no attraction prediction, invented consent or avoidance of an explicit boundary.

Fabricated personal facts, stale activity presented as current, extending an explicit goodnight, silently deleting a requested invitation/interest, and trying to work around explicit rejection are hard failures. A recommendation not to send can be useful when justified by the situation; absence of a question is not by itself such a justification. Gold describes behavior rather than exact text. Do not give these rubrics or gold outputs to the model being evaluated.

Three independent held-out inputs remain undisclosed until the implementation and development-case report are frozen. They must change surface topic, time language and evidence placement, and retain both permission to act and meaningful boundaries. They are not part of the thirteen-task development score. Reviewers retain disagreements and uncertainty; no claim of romantic outcome follows from passing.

After freezing, the runner's programmatic `runHarness({independentCases, ...})` accepts distinct independently authored fictional definitions with a new ID, family, exchange, request, nonnegative ageMs, fixed asOf and positive/negative criteria. It records their declaration hash separately and applies the same production path and HTTP ceiling. Built-in selection and independent definitions cannot be mixed. There is no CLI facility to load arbitrary data files, and held-out criteria remain report-only.

## Execution and evidence

The runner uses the real Store, Controller, planner, restricted composer and response parser. Q0 uses Controller.suggest rather than impersonating that path with an explicit private request. Fixed module-local clocks work for the candidate and an older source root; no global Date mutation occurs. Default transport is synthetic and its text is deliberately labeled non-semantic evidence. Only explicit `--live` reads the active MAIN model configuration; it never loads real QQ records or images. Reports redact the API key and contain only fictional context. They omit request headers.

Global HTTP ceiling is 32 and the per-task ceiling is 4. The first transport exception, non-OK HTTP response or exhausted global cap stops subsequent tasks. In-model formatting repair counts against the same ceiling; no external retry overwrites a failed result. Transport success, deterministic contract checks, independent semantic judgments and actual relationship outcomes remain separate.

```bash
node scripts/goal-help-quality-check.cjs --describe
node scripts/goal-help-quality-check.cjs --out /tmp/qq-help-quality-dryrun.json
node scripts/goal-help-quality-check.cjs --live --cases Q1-live,Q1-delayed,Q2-closed --source-root /path/to/frozen/source --out /tmp/qq-help-quality-baseline.json
```

Output paths must be new JSON files outside private `data` directories and Git internals. The baseline and candidate must use identical scenario-document hashes and model configuration; the source root and actual payloads are recorded. Model responses remain unjudged until reviewers evaluate the visible help.
