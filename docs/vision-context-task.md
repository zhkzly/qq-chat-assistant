# Scoped vision context contract
Goal: Let the current QQ helper understand relevant images for truthful relationship assistance instead of silently receiving text placeholders.
Evidence: Current gpt-6-sol request contained0 images; capability/permission wereoff and manualselectionempty. One synthetic red-triangle/blue-circle request returned a correct description. Latest100 cachedmessages had14images,10 locallyreadable.
Authority: User explicitly permits this selected contact's recent relevant pictures to enter the currently selected model automatically; actual QQ sends remain forbidden.
Invariant: Four-field account/contact scope, model/destination consent, recalled/excluded source protection and unchanged original records/drafts.
Scope: Bounded automatic/manual selection, visible image-source mapping and omission status, consent/UI guards, meaningful tests and actual helper activation.
No: All-history image upload, broader account/model authorization, simulated QQ sending, permanent personality conclusions from a picture or research export of real images.

## Decisions
- Automatic context uses up to3 images in the latest20 actual messages within24hours; explicit reply focus may select older images, and explicit image selection overrides automatic selection.
- A missing automatically selected cache is reported and skipped; a specifically selected unavailable image still fails clearly rather than pretending it was read.
- Images remain separate from background memory model traffic; source indices/sender/time are included in each foreground model request.

## Verification decisions
- Applied image exclusion filters the live source list before context construction, preventing early-budget metadata validation from retaining a retired image.
- The in-turn exclusion regression uses the existing exact-target user-control contract. Safe action receipts can identify the excluded source; no later request may contain its pixels, attached metadata or evidence body.
- Functional suite output is also checked for explicit failed-test lines because this host's direct Node test invocation can report a zero child exit code despite failed test output.

## Candidate verification
- Ordinary functional tests: 436 checks across 60 files, zero failures; explicit output scan used in addition to process exit codes.
- Synthetic pointer browser: five checks, zero real model calls. Full application syntax and Git whitespace checks pass.
- Initial Controller/server acceptance failed on missing automatic authorization and an image-only scope bypass, then passed after implementation. No mutation checks required for this change.
