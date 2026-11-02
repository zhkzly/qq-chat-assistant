# Coordinator review: speaker-attribution candidate proposal (2026-11-02)

- Verdict: APPROVED for freezing at the next contract version bump. Do NOT freeze mid-stage: the current dataset hash d7890b62… is pinned by the prepared mc-sweep/cq-sweep rounds; adding the case now would invalidate their frozen bindings.
- Schema: matches the conversation.jsonl family exactly (family/tags/contrast_group/initial_context with qq_history+private_discussion, steps with qq_updates/private_updates/request/evaluation).
- Criteria quality: three steps; critical_failures name the exact user-reported failure mode (speaker swap: user's private "压力很大" attributed to the contact; care-direction reversal; invitation written as accepted). Contrast anchors to cm-local-correction-continuity. Evidence ids bound at every step.
- Coverage: no existing case exercises speaker-attribution swap (confirmed by the 38-case audit) — fills the gap that let the live "压力很大" failure ship unnoticed.
- Provenance: authored by the dsh-attr stream from the user's live symptom report; fictional content; no real chat data.
- Freeze procedure (next version bump): copy to evals/assistant/replay/ (converted to the replay family schema if the loader requires), run eval-dataset check for the new hash, update goal.json replay_dataset {hash, cases:39, steps:+3}, bump goal version, re-prepare affected rounds.