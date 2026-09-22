"""Intent submission, reviewer verdicts, and dry-run "would do" plans.

An intent is the unit the LLM proposes and a reviewer rules on: attach an
arrival to an existing book, create a new book for it, escalate a decision
to a human, or defer it. `IntentBook` is the hard boundary between "the LLM
asked for this" and "this run recorded it as accepted" -- every accepted
intent has already passed `policy.check_intent` under the shared run lock,
and every rejected one is still stored (so nothing an LLM asked for
silently disappears -- see the module docstring in app/policy.py for why
`check_intent` itself never mutates `run.claims`).

Two Store-backed tables sit behind one IntentBook: `self.store` for intents
themselves (keyed `f"{run_id}:{n}"`), and `self.arrivals` (the same Store
the rest of the service uses for arrival state) so a successful submit can
move the arrival's state in the same locked section.

`policy.check_intent`'s guard 6 only blocks a second FILING intent
(attach/create_book) for an arrival within a run. This module enforces a
wider plan rule on top of that: an arrival gets exactly one of {filing
intent, escalate, defer} per run. That is tracked with an ("arrival", key)
entry in `run.claims` -- the very tuple `policy.claims_for` already returns
for filing intents -- so guard 6 and this module's own pre-check share one
source of truth. Only an ACCEPTED intent claims the slot; a guard-rejected
one does not, so a rejected proposal can never block a legitimate retry.

`finalize_dry_run` is what turns the run's accepted intents into the
"would do" plan Plan 2's executor will eventually run for real: an approved
filing intent is simulated, an escalation (whether the LLM asked for it or
a reviewer's rejection produced it) leaves the arrival needing a human
decision, a still-unreviewed proposal is treated as rejected ("the reviewer
did not rule") and auto-escalated the same way an explicit rejection is,
and a deferred arrival is simply left alone -- it already carries its
`not_before` from submission time.
"""
import time

from app.policy import check_intent, claims_for, render_folder, validate_shape
from app.states import (
    APPROVED,
    ATTACH,
    CREATE_BOOK,
    DEFER,
    DEFERRED,
    ESCALATE,
    GUARD_REJECTED,
    NEEDS_DECISION,
    PROPOSED,
    PROPOSED_I,
    REJECTED,
    SIMULATED,
    SIMULATED_I,
)

# BookOrbit's API never returns a numeric library id (only `libraryName`);
# these are the plan's own fixed ids for the two real filing libraries (see
# the plan's global constraints). "adult"/"kids" are the intent-facing keys
# an LLM uses in `create_book.library`; the display names are what
# `LibraryIndex.book()` actually returns in `libraryName`.
_LIBRARY_NAME_FOR = {"adult": "Library", "kids": "Kids Audiobooks"}
_LIBRARY_IDS = {"Library": 7, "Kids Audiobooks": 8}


class IntentBook:
    def __init__(self, store, arrivals, lock, clock=time.time):
        self.store = store
        self.arrivals = arrivals
        self.lock = lock
        self.clock = clock

    # --- id allocation -------------------------------------------------------

    def _next_id(self, run_id: str) -> str:
        n = sum(1 for r in self.store.all() if r.get("run_id") == run_id) + 1
        return f"{run_id}:{n}"

    # --- submission ------------------------------------------------------------

    def submit(self, run, intent, ctx_factory) -> dict:
        """Validate `intent` (shape + guards) and record the outcome.

        `run` is the Run the LLM is currently executing under -- `run.claims`
        is read/written here (both this module's own one-per-arrival claim
        and, via `policy.claims_for`, the filing-specific claims guard 6
        checks), and `run.run_id` seeds the stored intent's key and the
        arrival-state transition.
        """
        with self.lock:
            arrival = intent.get("arrival") if isinstance(intent, dict) else None
            kind = intent.get("kind") if isinstance(intent, dict) else None

            ok, reason = validate_shape(intent)
            if ok and ("arrival", arrival) in run.claims:
                ok, reason = False, "arrival already has an intent this run"

            ctx = None
            if ok:
                ctx = ctx_factory(arrival)
                ok, reason = check_intent(intent, ctx)

            intent_id = self._next_id(run.run_id)

            if not ok:
                self.store.record(
                    intent_id, GUARD_REJECTED, run_id=run.run_id, arrival=arrival,
                    kind=kind, payload=intent, reason=reason, guard=reason, review=None,
                )
                return {"intent_id": intent_id, "status": GUARD_REJECTED, "reason": reason}

            claims = set(claims_for(intent, ctx.dossier))
            claims.add(("arrival", arrival))
            for claim in claims:
                run.claims[claim] = intent_id

            self.store.record(
                intent_id, PROPOSED_I, run_id=run.run_id, arrival=arrival, kind=kind,
                payload=intent, reason=intent.get("reason"), guard=reason, review=None,
            )

            if kind in (ATTACH, CREATE_BOOK):
                self.arrivals.record(arrival, PROPOSED)
            elif kind == ESCALATE:
                self.arrivals.record(arrival, NEEDS_DECISION)
            elif kind == DEFER:
                not_before = self.clock() + intent["not_before_hours"] * 3600
                self.arrivals.record(arrival, DEFERRED, not_before=not_before)

            return {"intent_id": intent_id, "status": PROPOSED_I, "reason": reason}

    # --- queries ---------------------------------------------------------------

    def proposals(self, run_id: str) -> list:
        return [
            r for r in self.store.all()
            if r.get("run_id") == run_id and r.get("state") == PROPOSED_I
        ]

    # --- reviewer verdicts -------------------------------------------------------

    def apply_review(self, run, intent_id: str, verdict: str, argument: str) -> dict:
        """Apply a reviewer's verdict to a proposed intent.

        `run` is the REVIEWER's own Run (`mode="reviewer"`); `run.reviewed`
        guards against this reviewer run ruling on the same intent twice.
        Returns an error dict (`{"error": ..., "reason": ...}`) on any
        failure -- unknown intent, wrong state, already reviewed, or a bad
        verdict -- for the API layer to map to the appropriate HTTP status.
        """
        if verdict not in ("approve", "reject"):
            return {"error": "bad_request", "reason": f"unknown verdict {verdict!r}"}

        with self.lock:
            rec = self.store.get(intent_id)
            if rec is None:
                return {"error": "not_found", "reason": f"no such intent {intent_id!r}"}
            if rec.get("state") != PROPOSED_I or intent_id in run.reviewed:
                return {"error": "conflict", "reason": "intent is not awaiting review"}

            run.reviewed.add(intent_id)

            if verdict == "approve":
                self.store.record(intent_id, APPROVED, review={"verdict": "approve", "argument": argument})
                return {"intent_id": intent_id, "status": APPROVED}

            esc_id, _ = self._reject_and_escalate(
                rec, argument=argument, question=f"The reviewer objected: {argument}",
            )
            return {"intent_id": intent_id, "status": REJECTED, "escalation_id": esc_id}

    def _summary(self, rec: dict) -> str:
        """A one-line summary of a filing intent, for an escalation option."""
        payload = rec.get("payload") or {}
        kind = rec.get("kind")
        if kind == ATTACH:
            return f"attach {rec.get('arrival')} to book {payload.get('book_id')}"
        if kind == CREATE_BOOK:
            title = (payload.get("metadata") or {}).get("title", "?")
            return f"create book '{title}' in {payload.get('library')}"
        return f"{kind} for {rec.get('arrival')}"

    def _reject_and_escalate(self, rec: dict, *, argument: str, question: str):
        """Mark `rec` rejected and file the auto-escalation the plan requires
        whenever a filing intent doesn't go through: an explicit reviewer
        rejection, or (via `finalize_dry_run`) a proposal nobody ruled on."""
        self.store.record(rec["intent_id"], REJECTED, review={"verdict": "reject", "argument": argument})

        payload = {
            "kind": ESCALATE,
            "arrival": rec["arrival"],
            "question": question,
            "options": [
                {"label": f"Proceed: {self._summary(rec)}", "intent": rec.get("payload")},
                {"label": "Leave it for me"},
            ],
            "recommendation": "decide",
            "origin": "reviewer",
        }
        esc_id = self._next_id(rec["run_id"])
        self.store.record(
            esc_id, PROPOSED_I, run_id=rec["run_id"], arrival=rec["arrival"], kind=ESCALATE,
            payload=payload, reason=argument, guard=None, review=None,
        )
        return esc_id, payload

    # --- dry-run finalize --------------------------------------------------------

    def finalize_dry_run(self, run_id: str, index=None) -> None:
        """Turn this run's accepted intents into arrival-visible "would do"
        plans. `index` is the LibraryIndex snapshot used to resolve an
        attach's target folder -- safe to reuse the run's own index since
        DRY_RUN never writes to BookOrbit, so nothing has changed underneath
        it since the run started.
        """
        with self.lock:
            for rec in [r for r in self.store.all() if r.get("run_id") == run_id]:
                kind = rec.get("kind")
                state = rec.get("state")

                if kind in (ATTACH, CREATE_BOOK):
                    if state == APPROVED:
                        wd = would_do(rec["payload"], index=index)
                        self.store.record(rec["intent_id"], SIMULATED_I, would_do=wd)
                        self.arrivals.record(rec["arrival"], SIMULATED, would_do=wd)
                    elif state == PROPOSED_I:
                        _esc_id, esc_payload = self._reject_and_escalate(
                            rec, argument="reviewer did not rule",
                            question="The reviewer did not rule on this proposal before the run ended.",
                        )
                        wd = would_do(esc_payload, index=index)
                        self.arrivals.record(rec["arrival"], NEEDS_DECISION, would_do=wd)

                elif kind == ESCALATE:
                    wd = would_do(rec["payload"], index=index)
                    self.arrivals.record(rec["arrival"], NEEDS_DECISION, would_do=wd)

                # DEFER: the arrival was already recorded DEFERRED with its
                # not_before at submit time -- nothing to do here.


# --- would_do ------------------------------------------------------------------


def would_do(intent: dict, index=None) -> list:
    """The ordered action list Plan 2's executor would run for `intent`.

    `index` (a LibraryIndex) is only used for `attach`, to resolve the
    target book's real on-disk folder -- every other kind's plan is built
    entirely from the intent payload.
    """
    kind = intent.get("kind")
    if kind == ATTACH:
        return _would_do_attach(intent, index)
    if kind == CREATE_BOOK:
        return _would_do_create_book(intent)
    if kind == ESCALATE:
        return _would_do_escalate(intent)
    if kind == DEFER:
        return _would_do_defer(intent)
    return []


def _would_do_attach(intent: dict, index) -> list:
    book_id = intent["book_id"]
    book = index.book(book_id) if index is not None else None
    library_id = _LIBRARY_IDS.get((book or {}).get("libraryName"), "?")

    folder_path = (book or {}).get("folderPath")
    if index is not None and folder_path:
        folder = index.local_path(folder_path)
    else:
        folder = folder_path or f"<book {book_id}>"

    return [
        f"snapshot metadata of book {book_id}",
        f"mv <primary> -> {folder}/",
        f"scan library {library_id} and wait for finish",
        "verify file listed",
        "restore/lock identity fields",
        f"rename-files {book_id}",
        "remove intake folder",
    ]


def _would_do_create_book(intent: dict) -> list:
    metadata = intent["metadata"]
    library_name = _LIBRARY_NAME_FOR.get(intent["library"], intent["library"])
    library_id = _LIBRARY_IDS.get(library_name, "?")
    rendered = render_folder(
        metadata["authors"][0], metadata.get("series"), metadata.get("seriesIndex"), metadata["title"],
    )
    folder = f"{library_name}/{rendered}"

    return [
        f"create book folder {folder}",
        f"mv <primary> -> {folder}/",
        f"scan library {library_id} and wait for finish",
        "verify book created",
        "set identity fields",
        "rename-files <new book>",
        "remove intake folder",
    ]


def _would_do_escalate(intent: dict) -> list:
    return [
        f"create Vikunja task: {intent['question']}",
        f"push: {intent['arrival']} needs a decision",
    ]


def _would_do_defer(intent: dict) -> list:
    return [f"wait {intent['not_before_hours']}h before re-offering {intent['arrival']}"]
