# os-context's own lint rules (hand-over for D10)

These rules were in the shared `diagnostics.md` while the format lived in
os-context. They are os-context's, not the core's (DEC-S05): its runtime
extension implements them and this text moves to os-context's documentation.
Moved verbatim from os-context commit 7633e176 (worktree `typescript-binding`).

| `E214` | error | A suite imports the shared checks library (`_lib/shared-checks.yml`, step 3.3) and neither calls one of its five checks nor lists it in `sharedChecks.skip`; or it skips a check without a `sharedChecks.reason`, or skips a name that is not a shared check. |

### Not in this contract: the catalog lint

The scenario catalog has its own lint over this repository's suites (codes
`E401` to `E405`, described in [test/e2e/suites/README.md](../suites/README.md#the-catalog-lint)).
It is PowerShell-only and deliberately not tabled here: every code tabled in
this file is one all four bindings produce and the conformance corpus
compares, and the catalog lint is about the repository's corpus rather than
about what a suite means.


| `timeoutSec` | a case, or `defaults` | 14400 seconds, in a suite not tagged `lifecycle` |

| `timeoutSec` | a case in a suite tagged `lifecycle` | 900 seconds, and **required**: every such case declares its own limit (R1.8 plus the SF-10 user override) |

| `timeoutSec` | `defaults` in a suite tagged `lifecycle` | refused: a default would hide which cases fit the fifteen-minute budget, and which do is what the rule exists to state |

The lifecycle rule is the one the runner enforces before it executes anything,
so a suite that lints clean cannot then be refused at run time. Until Y2.3 it
was the other way round - no lifecycle case could declare a limit, because
nothing enforced one and the number would have been read by nobody. Y2.3 made a
limit enforceable by cancelling the step that runs past it, so the rule became
R1.8's, with the SF-09 operator override: every lifecycle case declares its own,
between 1 and 900. R3.6 removes
the temporary budget skip mechanism: tags only perform ordinary selection.
A selected case that exceeds its declared limit fails.


