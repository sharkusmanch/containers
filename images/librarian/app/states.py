"""State/kind constants and shared cross-module types.

Kept dependency-free (stdlib only) so every other module -- including
app/store.py, whose allowed_states argument is built from these -- can import
it without a cycle.
"""
from dataclasses import dataclass, field

# --- arrival states ----------------------------------------------------------
READY = "ready"
PROPOSED = "proposed"
NEEDS_DECISION = "needs-decision"
ANSWERED = "answered"
DEFERRED = "deferred"
SIMULATED = "simulated"
FILED = "filed"
DUPLICATE = "duplicate"
FAILED = "failed"
RETRYABLE = "retryable"
# Plan 2: the executor is mid-filing. The arrival's `exec` journal says which
# step; app/executor.py's Executor.resume() owns every arrival in this state.
EXECUTING = "executing"

ARRIVAL_STATES = frozenset({
    READY, PROPOSED, NEEDS_DECISION, ANSWERED, DEFERRED, SIMULATED,
    FILED, DUPLICATE, FAILED, RETRYABLE, EXECUTING,
})

# An arrival is offerable to the librarian run when it's freshly ready or has
# just been answered. DEFERRED only re-joins this set once its `not_before`
# has passed -- that comparison is time-dependent so it is NOT baked into this
# static frozenset; callers must check `not_before` themselves.
OFFERABLE = frozenset({READY, ANSWERED})

# --- intent states -------------------------------------------------------
PROPOSED_I = "proposed"
APPROVED = "approved"
REJECTED = "rejected"
GUARD_REJECTED = "guard-rejected"
SIMULATED_I = "simulated"
EXECUTED = "executed"          # Plan 2: the executor filed it
EXEC_FAILED = "exec-failed"    # Plan 2: the executor gave up (human looks)

INTENT_STATES = frozenset({
    PROPOSED_I, APPROVED, REJECTED, GUARD_REJECTED, SIMULATED_I, EXECUTED, EXEC_FAILED,
})

# --- intent kinds -----------------------------------------------------------
ATTACH = "attach"
CREATE_BOOK = "create_book"
ESCALATE = "escalate"
DEFER = "defer"
# Plan 2, Task 3: correct identity/series metadata on the book an arrival is
# attached to, in the same run as that attach.
UPDATE_METADATA = "update_metadata"

INTENT_KINDS = frozenset({ATTACH, CREATE_BOOK, ESCALATE, DEFER, UPDATE_METADATA})


@dataclass
class Run:
    """One librarian or reviewer invocation of `claude -p`.

    Mutable defaults use default_factory -- a bare `{}`/`set()` default would
    be shared across every Run instance.
    """
    run_id: str
    token: str
    mode: str  # "librarian" | "reviewer"
    arrival_keys: list[str]
    review_of: str | None = None
    seen_ids: dict[str, set[int]] = field(default_factory=dict)
    claims: dict = field(default_factory=dict)
    reviewed: set[str] = field(default_factory=set)
