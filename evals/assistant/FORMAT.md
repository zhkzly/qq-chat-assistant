# Dataset v1 authoring contract

Each JSONL line is one fully fictional case. English keys; Chinese conversation text and criteria are allowed. Required top-level keys: schema_version (1), id (stable lowercase ASCII identifier), family, goal_type (relationship/friendship/work/learning/support), goal, tags (nonempty distinct strings), contrast_group (nonempty string), initial_context, steps (one or more).

initial_context: {as_of: timezone-aware ISO timestamp, qq_history:[], private_discussion:[], notes:[]}.
QQ event: {id:string, at:timezone-aware ISO, speaker:self|contact, text:string}.
Private event: {id:string, at:timezone-aware ISO, role:user|assistant, text:string}.
Note: {id:string, at:timezone-aware ISO, subject:self|contact|dyad, kind:material|preference|understanding, use:discussion|draft, text:string, source_ids:[]}. Material/preferences may have empty source_ids when an explicit fictional user-authored note is the source. Understanding notes must cite prior actual QQ or user-authored private evidence; an assistant-only interpretation is not independent evidence. Assistant wording is never proof that QQ was sent or her feelings exist.

Step: {id:string, as_of:timezone-aware ISO, qq_updates:[], private_updates:[], request:{id:string,text:string}, evaluation:{acceptable_outputs:[], should:[], should_not:[], critical_failures:[], evidence_ids:[]}}.
acceptable_outputs is a distinct nonempty subset of draft/discussion/clarification/wait. Other evaluation arrays contain nonempty strings; should/should_not/evidence_ids are nonempty, critical_failures may be empty. evidence_ids reference currently available original QQ/private/note/request IDs, never future steps or prior generated output that has not been provided. Request at is the step's as_of. Step/source IDs are unique within a case, including all requests. Times are chronological and no source is later than the step in which it becomes available; updates must not predate the preceding step. A future plan described in text is fine; its utterance time is past/current.

QQ/private records are separate timelines, both sorted by at. Steps are incremental. A fixed human outgoing QQ update is an authored test condition, not proof that a model candidate was adopted. To evaluate actual carried model state, a future runtime runner must also bind its real predictions and traces; the data alone does not prove continuity.

Keep criteria behavioral and permit multiple sensible approaches. Do not prescribe one joke, number of questions, exact response text or character count. A direct invitation may be appropriate when requested. Quoted third-party wishes are not user preferences. Temporary fatigue is not a permanent trait. At least two non-romantic goals and multiple multi-step cases belong in this first development set. All authored cases are visible development/regression fixtures, never claim they are unseen holdouts.

Authors own separate JSONL shards; the root validator reads every *.jsonl file in this directory. Root owns rubric and checker. Do not add executable model examples or invoke a model while authoring.
