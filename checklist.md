# Implementation acceptance

- [x] Normal QQ remains usable; original installation and conversations preserved, backup retained.
- [x] QQ private entry opens/reuses helper and automatically selects that window's friend; actual native switch verified.
- [x] Native history loads without export/import; actual 739 records, both directions, coverage and full UI browsing verified.
- [ ] Real fresh incoming-message-to-suggestion canary remains unobserved; source-shaped incoming/successful-sent callbacks are implemented and tested.
- [x] Account/contact/stale-window/stale-generation boundaries and pending UI fill cancellation tested with killed mutants.
- [x] Model settings and exact context preview available; current text permission is scoped, image permission separate; synthetic model/vision requests verified.
- [x] QQ draft insertion confirmed by native editor, restores test text, preserves existing drafts; no sending capability exposed or test send performed.
- [x] Native export includes only selected actual records, string IDs and coverage, excludes drafts/private media paths.
- [x] Native/synthetic evidence and private documentation archive kept separate; no real chats, keys or private screenshots archived.
- [x] Old automatic-reply connector remains stopped; assistant updates suggestions while human retains QQ send control.
