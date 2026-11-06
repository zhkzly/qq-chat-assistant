# Acceptance checklist

- [x] Cases distinguish entity/time/condition/update/availability dimensions without a single forced exclusive relation label.
- [x] Every observation has an original ID, source time, channel and speaker; changes and seed provenance are recorded.
- [x] Model/runtime export excludes family, adaptation, provisional reference labels and reviewer criteria.
- [x] Validation rejects future evidence, unknown references and hidden runtime fields before calling an adapter.
- [x] Default/check/list/export do not load adapters or call a model.
- [x] Replay retains complete actual output, adapter/contract/data/input identity, timing, failure and ungraded review envelopes.
- [x] Live and synthetic identities cannot be confused; injected Luna transport is labeled synthetic and JEV remains unverified.
- [x] Focused boundary/CLI tests run, and documentation separates component diagnosis from end-to-end integration.
