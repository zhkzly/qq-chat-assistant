---
name: qq-goal-iteration
description: Coordinate a bounded QQ assistant improvement round using frozen replay evidence and separate implementer, evaluator, and diagnostician roles. Use when progressing the project Goal, not for an ordinary QQ consultation.
---

# QQ assistant Goal iteration

Act as the coordinator. Read `goals/assistant-improvement/GOAL_CN.md` and its referenced contract and stage queue before selecting work. Keep the active stage, unresolved evidence, and stop conditions visible. A Goal is user authorization only within its declared scope and budget; it does not bypass inherited permissions or authorize QQ sends.

Start conversation behavior work with `npm run eval:check`, `npm run eval:list`, and `npm run eval:replay:list`. Use `node scripts/goal-round.cjs --help` for the maintained round interface. Prepare a new round before implementation, freeze the selected raw cases and rubric, and keep a meaningful counterexample. Do not replace the frozen observations with derived memories or rewrite criteria to rescue a candidate.

Delegate product changes to `qq_implementer`. Give it the bounded change and acceptance conditions, not the evaluator's judgments as expected product answers. Delegate actual hash-bound reviewer packets to `qq_evaluator`; provide the complete packet inline because that role has no shell. Do not include candidate identity, source paths, implementation hypotheses, preferred verdicts, or calibration reference labels. Keep its actual response unchanged. Use `qq_diagnostician` after an observed failure or disagreement; supply run diagnostics separately from the blinded reviewer packet.

Keep baseline and candidate case, policy, rubric, time, model, and resource conditions comparable. Synthetic replay proves integration only. Real selected-model replay requires explicit `--live` authorization and the declared global HTTP cap. Record actual inputs, outputs, missing steps, errors, versions, and reviewer disagreements. An unrun review remains ungraded; incomplete, synthetic, or uncertain evidence cannot establish product improvement.

Attach actual replay artifacts, create the blinded packet, record the separate actual review, and run the round checks before deciding whether to continue, accept, or stop. Accept only within the Goal contract's evidence boundary. Stop or escalate when its budget, stage gate, uncertainty, repetition, or authorization limit is reached. Do not activate a Goal, run paid models, commit, publish, or alter global settings unless separately authorized.

Read `evals/assistant/REPLAY.md` when choosing replay flags, adapters, or interpreting evidence. Read `evals/assistant/calibration/README.md` when introducing a reviewer or changing its rubric/Judge version; use the blinded calibration export and preserve the actual hash-bound comparison and disagreements. The visible fictional development cases and provisional AI references are not unseen or human-verified evidence.
