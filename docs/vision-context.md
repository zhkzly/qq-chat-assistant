# Scoped visual context

The helper can use accessible QQ image caches to understand the selected private conversation. The native QQ client remains the place where messages are manually sent; the helper never sends, forwards or automatically replies to QQ.

## Selection and permission

Text permission, verified model image capability, image permission and automatic-image permission are separate gates. New image grants bind all four account/contact identity fields, the selected model and the destination URL. Legacy image permission supports manual selection only. Changing the contact, account, model or destination cannot inherit an automatic image grant.

Automatic selection uses up to three images from the latest 20 actual messages within 24 hours. Explicit reply focus can include older image messages. Manual image selection takes priority. Withdrawn or excluded evidence is unavailable to the selector. Missing automatic cache entries are skipped and reported; an unreadable explicitly selected image stops the request with a recoverable error. Cache reads use the existing allowed QQ/Downloads roots, file-type checks and 8 MiB limit per image.

## Context and lifecycle

Every actual multimodal request includes a bounded `imageContext` map. The map's ordinal matches the order of image parts, and each entry contains the original string QQ source ID, element index, source-derived sender and time. The assembler budgets metadata with the complete text request and protects the corresponding QQ sources. Pixels have a separate byte bound. The draft projection retains the image map without importing private discussion as sendable content. A text-only format repair explicitly reports an empty attachment map; repairs that retain pixels retain the same source mapping.

Model instructions distinguish actual attached pixels, missing-cache entries, text placeholders and prior descriptions. Images can support observations about visible content; they cannot establish a person's identity, feelings, personality or romantic interest. Screenshot text is data, not instructions.

Binary data and local cache paths stay out of manifests, stored discussion, exports and research archives. Source deletion, permission changes and conversation changes invalidate active assistance. Late browser preview results are discarded and their object URLs revoked after a scope change.

The discussion panel displays the attachment count and offers automatic selection, scoped permission, manual override reset and a link to QQ history. The count means what the next request is prepared to attach; each saved run separately records what that request actually attached.

Automatic cache scans are capped at 60 candidates from the recent window plus at most 12 explicit focus messages; cache misses cannot trigger an unbounded history scan.

## Verification boundaries

Selection, consent, budget, draft/repair and asynchronous preview tests use synthetic native-shaped records. Browser evidence proves the synthetic helper UI only. A synthetic red-triangle/blue-circle request verified the configured local endpoint's current selected model could accept image input; the physical upstream model identity was not independently established. Desktop activation and real-image request results are recorded separately after execution, without private pixels or chat transcripts.

Candidate verification on 2026-10-14: 436 functional checks across 60 files passed with zero failures; five synthetic browser checks passed with zero real model calls.

Actual desktop verification on 2026-10-14: the refreshed existing helper displayed automatic selection of two images and one cache omission. One scoped helper task sent both images with canonical source maps and received HTTP 200 and a discussion answer in one model request. The model read the visible caption of a previously user-provided screenshot's meme and expressed uncertainty about an unidentified object in another picture. This is a bounded integration result, not a general accuracy benchmark. The QQ parent, all inspected unsent input hashes, unrelated settings, goal and scope were preserved; all original 900 message rows remained byte-equivalent. No QQ messages were sent, and no image binaries were persisted in the run or copied into Git or research archives.
