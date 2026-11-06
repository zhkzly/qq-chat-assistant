# Unlimited experiment HTTP mode

Frozen scope: add explicit unbounded global experiment accounting to adapters,
runners and round evidence. Preserve finite defaults, product request limits,
timeouts, provider selection, approvals, frozen data and prior evidence.

The user authorized no aggregate HTTP cap. `null` is accepted only with an
explicit unlimited flag, never as accidental coercion to zero or Infinity.
The main coordinator owns the new Goal contract and activation.

Acceptance checks: unlimited identity survives JSON; traffic above the former
cap is recorded; finite mode still stops; contradictory flags reject; rounds
require authorized unlimited mode and matching arm budgets; preparation keeps
nonprogress/error stops without a fixed checkpoint-count stop in unlimited mode.

New Goal directories are selected explicitly; the existing project Goal stays
unchanged. Mutation-license checks are optional under current user instructions.
