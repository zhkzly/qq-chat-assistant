# QQ IPC lifecycle recovery

## Failure and correction

The previous transport retained one renderer IPC context. A temporary renderer could replace that context and subsequently disappear, leaving a valid authenticated account but no usable read context. A synthetic main/temporary-window sequence reproduces this failure. The original failing desktop request was not instrumented with sender liveness, so its exact disappeared sender is not claimed as verified.

A separate failure was reproduced on the running assistant: a successful older-history read reached the accessible end, while `coverage.error` and the global read error retained `QQ IPC is not ready`. Successful pages now remove the old coverage error and clear only the matching global read error. A newer unrelated error survives.

The transport stores whole original captured contexts per renderer, validates account ownership and session/renderer epochs, and selects another live context after renderer loss. It never transfers a saved header to an invented sender. Destruction, renderer loss and main-frame navigation retire the affected context and pending reads. Responses must match their original sender, account and epoch; a wrong sender cannot consume the request. Login duplicates preserve valid reads, while actual logout and same-account relogin retire the old session. Failed session initialization cannot establish ownership.

`status.nativeReadReady` describes the available native read context separately from authenticated `phase: ready`. A read-channel change preserves the selected contact and current helper inputs. The UI can continue private discussion from cached QQ evidence while displaying that reading awaits recovery. Adapters without the optional readiness capability retain their previous status shape.

Only the original latest-history and older-history routes remain allowed. No sending, forwarding or automatic QQ reply capability was added.

## Evidence, 2026-10-13

- Functional: 365 tests pass, including lifecycle, callback ownership, duplicate-login, in-place-upgrade, scope and stale-error regressions. Application JavaScript parsing and `git diff --check` pass.
- Synthetic pointer browser: three checks pass at 370 by 560. Prepared private text, draft, goal, note, feedback target/text, selected help mode and scope survive readiness loss/restoration. Cached records remain usable for private help. This is not desktop integration evidence.
- Actual desktop: the observed assistant read response returned to the same original sender. The reviewed transport and driver were applied to their existing owned instances; the original adapter, listeners, account and selected scope were retained. No authentication/header reconstruction was used.
- Actual desktop: after the upgrade, both allowed routes returned 50 scoped messages. Every returned native message ID remained a string; sender and peer checks passed, with no pending request left over.
- Actual assistant: only the two reviewed history methods were replaced on the existing Controller prototype using a temporary loopback debugger. No constructor, `capture`, `bind`, worker restart, token rotation or page reload was performed. Active-task checks preceded the update; existing automatic schedules were briefly deferred and restored in `finally` around one history page. That page cleared the stale coverage error and made zero model requests during the measured read.
- Preservation: the selected scope, epoch, settings, goal and every existing record's digest matched before/after; 787 records remained. The original QQ and assistant processes and private launch token remained intact. The temporary debugger was confirmed closed.

Private verification data remains under ignored `data/`; credentials and original conversations are absent from this review. No QQ message was sent and the installed QQ application was not modified. Window-destruction fallback is established by functional tests; no user window was destroyed to manufacture desktop proof.

## Operational boundaries

No authenticated live context means that native reading remains unavailable. A later natural QQ IPC request can make it ready; an account-ready flag alone is insufficient. Local accessible-history completion describes the client boundary, not all lifetime QQ history. The native helper window was closed during recovery, so no claim of a visual comparison of that user's open helper is made; the existing browser DOM was left untouched and the new UI contract was separately tested.

Rollback of source is a Git revert of the implementation and diagnostic commits. Runtime prototype application is developer-only, explicitly probe-gated, and preserves the existing object rather than creating a parallel integration. The one-time Controller update retains old method descriptors for failure rollback and closes its temporary debugger in `finally`.
