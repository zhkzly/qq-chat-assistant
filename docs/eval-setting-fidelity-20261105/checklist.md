# Acceptance checklist

- [x] Raw QQ, archived user/assistant turns and authored notes are checked against the actual restored product state, with identity/role/time/use metadata retained.
- [x] An authored prefix is distinct from new runtime outputs and from implementation-derived memory.
- [x] Controlled reconstruction and scheduled-prefix settings have distinct preparation receipts; forced maintenance is observable.
- [x] A failed or partial preparation remains visible, including journal and semantic-review status; it does not become a quality verdict.
- [x] Preparation evidence stays outside reviewer-only quality packets and is exported in a separate artifact.
- [x] Contract JSON and effective non-secret model/runtime settings are fingerprinted without changing frozen historical hashes or leaking credentials.
- [x] Live runs remain explicit and globally capped; synthetic checks make no quality claims.
- [x] Existing replay and scheduled-idle regression tests still pass.

Final evidence: `validation-evidence.json`, `focused-tests.log` (98), `compatibility-tests.log` (40), and `seed-provenance-audit.json` (20 references). JavaScript syntax and diff-whitespace checks passed. Two local HTML screenshots were inspected. These checks do not assign semantic-quality ratings.
