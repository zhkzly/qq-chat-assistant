# Model picker acceptance

- [x] Existing single settings migrate without losing credentials or the chosen model.
- [x] Current API model IDs load, can be selected, and manual IDs remain possible.
- [x] Named provider profiles can be saved and switched without exchanging keys.
- [x] Changing a destination with a blank key cannot reuse the old destination key.
- [x] Public endpoints never return stored keys.
- [x] Model changes cancel old advice and enforce destination/model consent.
- [x] Model discovery errors retain editable/manual configuration and do not commit partial settings.
- [x] UI works at the narrow native window width, with stale model-list responses discarded.
- [x] Installed runtime is checked without QQ sends or private-chat model tests.

Evidence: 64 ordinary functional cases, 16 synthetic browser checks, matching installed source hashes, and research/models-native-evidence.json (26 real provider IDs in the native helper; draft preserved; no QQ sends or private-chat inference tests).
