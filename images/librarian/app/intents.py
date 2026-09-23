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

Every accepted intent of a finalized run ends in a TERMINAL intent state
(final review I2): filings are `simulated` or `rejected`, and escalations
(LLM-authored or auto-filed) and deferrals are `simulated` too -- in DRY_RUN
"simulated" is exactly "the would-do plan was recorded". Only an
interrupted run can therefore leave `proposed`/`approved` intents behind,
which is what app/service.py's startup recovery keys on; a finalized run's
escalations can never be mistaken for a crashed run's partial effects,
whether or not its runs.jsonl record survived.
"""
import time

from app import bookmeta
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
    RETRYABLE,
    SIMULATED,
    SIMULATED_I,
    UPDATE_METADATA,
)

# BookOrbit's API never returns a numeric library id (only `libraryName`);
# these are the plan's own fixed ids for the two real filing libraries (see
# the plan's global constraints). "adult"/"kids" are the intent-facing keys
# an LLM uses in `create_book.library`; the display names are what
# `LibraryIndex.book()` actually returns in `libraryName`.
_LIBRARY_NAME_FOR = {"adult": "Library", "kids": "Kids Audiobooks"}
_LIBRARY_IDS = {"Library": 7, "Kids Audiobooks": 8}

# Defer limit (final review I4): at most DEFER_LIMIT accepted defers per
# arrival, and none once DEFER_WINDOW has passed since the first one.
DEFER_LIMIT = 3
DEFER_WINDOW = 7 * 86400
DEFER_LIMIT_REASON = "defer limit reached — escalate"

# Only filing intents (plus update_metadata, Plan 2 Task 3) are ever put
# before the reviewer (final review I1).
_REVIEWABLE = frozenset({ATTACH, CREATE_BOOK, UPDATE_METADATA})


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
            if ok:
                ok, reason = self._arrival_slot_check(run, arrival, kind, intent)

            ctx = None
            if ok:
                ctx = ctx_factory(arrival)
                ok, reason = check_intent(intent, ctx)
            if ok and kind == DEFER:
                ok, reason = self._defer_allowed(arrival)

            intent_id = self._next_id(run.run_id)

            if not ok:
                self.store.record(
                    intent_id, GUARD_REJECTED, run_id=run.run_id, arrival=arrival,
                    kind=kind, payload=intent, reason=reason, guard=reason, review=None,
                )
                return {"intent_id": intent_id, "status": GUARD_REJECTED, "reason": reason}

            claims = set(claims_for(intent, ctx.dossier))
            if kind == UPDATE_METADATA:
                claims.add(("meta", arrival))
            else:
                claims.add(("arrival", arrival))
            for claim in claims:
                run.claims[claim] = intent_id

            self.store.record(
                intent_id, PROPOSED_I, run_id=run.run_id, arrival=arrival, kind=kind,
                payload=intent, reason=intent.get("reason"), guard=reason, review=None,
                submitted_at=self.clock(),
            )

            if kind in (ATTACH, CREATE_BOOK):
                self.arrivals.record(arrival, PROPOSED)
            elif kind == ESCALATE:
                self.arrivals.record(arrival, NEEDS_DECISION)
            elif kind == DEFER:
                not_before = self.clock() + intent["not_before_hours"] * 3600
                self.arrivals.record(arrival, DEFERRED, not_before=not_before)
            # UPDATE_METADATA touches no arrival state of its own -- the
            # paired attach it corrects already owns it.

            return {"intent_id": intent_id, "status": PROPOSED_I, "reason": reason}

    def _arrival_slot_check(self, run, arrival, kind, intent) -> tuple[bool, str | None]:
        """The wider one-intent-per-arrival-per-run rule (module docstring),
        relaxed for exactly one pair (review amendment): update_metadata may
        join an arrival that already has an ACCEPTED attach in this run --
        i.e. `run.claims[("arrival", arrival)]` names an attach intent whose
        own `book_id` matches -- as long as this run hasn't already used
        update_metadata's own one-per-arrival slot (`("meta", arrival)`).
        Every other kind keeps the original all-or-nothing rule.
        """
        if kind != UPDATE_METADATA:
            if ("arrival", arrival) in run.claims:
                return False, "arrival already has an intent this run"
            return True, None

        if ("meta", arrival) in run.claims:
            return False, "arrival already has an update_metadata intent this run"
        attach_id = run.claims.get(("arrival", arrival))
        attach_rec = self.store.get(attach_id) if attach_id else None
        if attach_rec is None or attach_rec.get("kind") != ATTACH:
            return False, "update_metadata requires an accepted attach for this arrival in the same run"
        if (attach_rec.get("payload") or {}).get("book_id") != intent.get("book_id"):
            return False, "update_metadata's book_id must match this run's accepted attach for the arrival"
        return True, None

    def _defer_allowed(self, arrival: str) -> tuple[bool, str | None]:
        """Final review I4: a model could otherwise defer the same arrival
        forever -- one paid run per `not_before` window. Prior ACCEPTED
        defers (anything not rejected/guard-rejected: a discarded run's
        defer never took effect) are counted from the intent history; after
        DEFER_LIMIT of them, or DEFER_WINDOW seconds after the first one,
        the only way forward is to escalate."""
        prior = [
            r for r in self.store.all()
            if r.get("arrival") == arrival and r.get("kind") == DEFER
            and r.get("state") not in (REJECTED, GUARD_REJECTED)
        ]
        if not prior:
            return True, None
        firsts = [r.get("submitted_at", r.get("first_seen")) for r in prior]
        first = min((t for t in firsts if isinstance(t, (int, float))), default=None)
        if len(prior) >= DEFER_LIMIT or (first is not None and self.clock() - first >= DEFER_WINDOW):
            return False, DEFER_LIMIT_REASON
        return True, None

    # --- queries ---------------------------------------------------------------

    def proposals(self, run_id: str) -> list:
        """The run's FILING intents still awaiting a reviewer verdict.

        Escalations and deferrals are never reviewable (final review I1):
        the reviewer argues against filings only (spec §3.5 step 4). Letting
        it "approve"/"reject" an escalate would let it overrule a human
        question -- including the auto-escalation its own rejection filed.
        """
        return [
            r for r in self.store.all()
            if r.get("run_id") == run_id and r.get("state") == PROPOSED_I
            and r.get("kind") in _REVIEWABLE
        ]

    # --- reviewer verdicts -------------------------------------------------------

    def apply_review(self, run, intent_id: str, verdict: str, argument: str, precheck=None) -> dict:
        """Apply a reviewer's verdict to a proposed intent.

        `run` is the REVIEWER's own Run (`mode="reviewer"`); `run.reviewed`
        guards against this reviewer run ruling on the same intent twice.
        Returns an error dict (`{"error": ..., "reason": ...}`) on any
        failure -- unknown intent, wrong state, already reviewed, or a bad
        verdict -- for the API layer to map to the appropriate HTTP status.

        `precheck`, if given, is called with no arguments as the very first
        thing inside the locked section and must return `(ok, reason)`; a
        falsy `ok` short-circuits with `{"error": "conflict", "reason":
        reason}` before any state is read or written. This is how the API
        layer (app/api.py, fix round 1 I1) re-checks that the run applying
        this review hasn't been closed by the service between request auth
        and this locked section, without IntentBook needing to know
        anything about `Core` or run identity itself.
        """
        if verdict not in ("approve", "reject"):
            return {"error": "bad_request", "reason": f"unknown verdict {verdict!r}"}

        with self.lock:
            if precheck is not None:
                ok, reason = precheck()
                if not ok:
                    return {"error": "conflict", "reason": reason}

            rec = self.store.get(intent_id)
            if rec is None:
                return {"error": "not_found", "reason": f"no such intent {intent_id!r}"}
            if (rec.get("state") != PROPOSED_I or rec.get("kind") not in _REVIEWABLE
                    or intent_id in run.reviewed):
                return {"error": "conflict", "reason": "intent is not awaiting review"}

            run.reviewed.add(intent_id)

            if verdict == "approve":
                self.store.record(intent_id, APPROVED, review={"verdict": "approve", "argument": argument})
                return {"intent_id": intent_id, "status": APPROVED}

            if rec.get("kind") == UPDATE_METADATA:
                # Binding amendment: a reject of update_metadata just drops
                # it -- no auto-escalation. The arrival's own filing
                # (attach) already owns its escalation path if THAT gets
                # rejected instead (see _cascade_reject_metadata below).
                self.store.record(intent_id, REJECTED, review={"verdict": "reject", "argument": argument})
                return {"intent_id": intent_id, "status": REJECTED}

            esc_id, _ = self._reject_and_escalate(
                rec, argument=argument, question=f"The reviewer objected: {argument}",
            )
            self._cascade_reject_metadata(rec)
            return {"intent_id": intent_id, "status": REJECTED, "escalation_id": esc_id}

    def _cascade_reject_metadata(self, rec: dict) -> None:
        """Binding amendment: rejecting an attach/create_book drops any
        update_metadata this same run submitted for the same arrival too --
        no separate auto-escalation (the filing's own escalation already
        covers the arrival). Also catches an update_metadata a reviewer
        already APPROVED before rejecting its attach: an approved
        update_metadata whose attach was rejected must never execute, so
        this demotes it back to REJECTED rather than leaving it approved.
        """
        for other in self.store.all():
            if (other.get("run_id") == rec["run_id"] and other.get("arrival") == rec["arrival"]
                    and other.get("kind") == UPDATE_METADATA
                    and other.get("state") in (PROPOSED_I, APPROVED)):
                self.store.record(other["intent_id"], REJECTED,
                                  review={"verdict": "reject", "argument": "attach was rejected"})

    def _attach_ok_for(self, rec: dict) -> bool:
        """True iff `rec`'s (`update_metadata`) same-run, same-arrival
        attach is itself `APPROVED` or `SIMULATED_I` -- i.e. it will, or
        already did, actually file. Looked up fresh from the intent store
        rather than assumed from insertion order or from `_cascade_reject_
        metadata` having already run (fix round 1, Minor #6): a future
        change to submission order, or a bug that let update_metadata
        reach APPROVED without a real attach, must not be able to simulate
        (and later execute) a metadata patch for a book that was never
        actually attached to this arrival."""
        return any(
            other.get("run_id") == rec.get("run_id") and other.get("arrival") == rec.get("arrival")
            and other.get("kind") == ATTACH and other.get("state") in (APPROVED, SIMULATED_I)
            for other in self.store.all()
        )

    def describe(self, rec: dict) -> str:
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
                {"label": f"Proceed: {self.describe(rec)}", "intent": rec.get("payload")},
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

    # --- executor escalations (Plan 2 Task 4) ------------------------------------

    def record_escalation(self, run_id: str, arrival: str, question: str, *, reason: str,
                          options: list | None = None, origin: str = "executor") -> str:
        """File a code-authored escalation for a human (the executor failed,
        a pre-execution guard refused, a filing needs a look). Terminal at
        once (`simulated`: the "would do" is recorded) exactly like the
        escalations `finalize_dry_run` files, so startup recovery never
        mistakes it for a crashed run's partial effect. The caller holds
        `self.lock` and sets the arrival's own state."""
        payload = {
            "kind": ESCALATE, "arrival": arrival, "question": question,
            "options": options or [{"label": "Leave it for me"}],
            "recommendation": "decide", "origin": origin,
        }
        esc_id = self._next_id(run_id)
        self.store.record(esc_id, SIMULATED_I, run_id=run_id, arrival=arrival, kind=ESCALATE,
                          payload=payload, reason=reason, guard=None, review=None,
                          would_do=would_do(payload))
        self._clear_answer(arrival)
        return esc_id

    def _clear_answer(self, arrival: str) -> None:
        """Final review M4: a newer escalation supersedes the human answer
        to the previous one -- it must never unlock guards 7/10 for (or be
        read by the LLM as the answer to) a question it did not answer.
        Keeps the arrival's current state."""
        cur = self.arrivals.get(arrival)
        if cur is not None and cur.get("human_answer") is not None:
            self.arrivals.record(arrival, cur["state"], human_answer=None)

    def latest_escalation(self, arrival: str) -> dict | None:
        """The arrival's most recent FINALIZED escalation (state
        `simulated`: finalize, reviewer auto-escalation or executor), i.e.
        the question a human is being asked right now (Plan 2 Task 6).
        Store order is creation order -- `Store.record` updates a key in
        place -- so the last match is the newest."""
        latest = None
        for rec in self.store.all():
            if (rec.get("arrival") == arrival and rec.get("kind") == ESCALATE
                    and rec.get("state") == SIMULATED_I and isinstance(rec.get("payload"), dict)):
                latest = rec
        return latest

    def reject_paired_metadata(self, rec: dict, argument: str) -> None:
        """A filing that did not execute takes its same-run update_metadata
        with it (caller holds `self.lock`)."""
        for other in self.store.all():
            if (other.get("run_id") == rec.get("run_id") and other.get("arrival") == rec.get("arrival")
                    and other.get("kind") == UPDATE_METADATA
                    and other.get("state") in (PROPOSED_I, APPROVED)):
                self.store.record(other["intent_id"], REJECTED,
                                  review={"verdict": "reject", "argument": argument})

    # --- finalize --------------------------------------------------------------

    def repair_proposed(self, run_id: str, keys, index=None) -> None:
        """Startup repair after a crash inside a finalize (fix round 1):
        for each of `keys` still `proposed` once `_finalize` has re-run --
        i.e. finalize died between its own records -- finish the arrival's
        escalation. Idempotent: keyed on the current states only.
          * the run's filing for it is already simulated: the arrival
            becomes simulated too (with the intent's would_do);
          * the run already filed an escalation for it (proposed or
            simulated): simulate it and move the arrival to needs-decision;
          * else the run's filing for it was rejected (the crash hit
            between `_reject_and_escalate`'s two records): file that
            auto-escalation now, then the same.
        Anything else is left for startup recovery (reset to ready)."""
        with self.lock:
            for key in keys:
                if (self.arrivals.get(key) or {}).get("state") != PROPOSED:
                    continue
                mine = [r for r in self.store.all()
                        if r.get("run_id") == run_id and r.get("arrival") == key]
                simulated = [r for r in mine if r.get("kind") in (ATTACH, CREATE_BOOK)
                             and r.get("state") == SIMULATED_I]
                if simulated:
                    # dry-run finalize died between the intent's record and
                    # the arrival's: finish it (never reset to ready)
                    self.arrivals.record(key, SIMULATED, would_do=simulated[-1].get("would_do")
                                         or would_do(simulated[-1]["payload"], index=index))
                    continue
                escs = [r for r in mine if r.get("kind") == ESCALATE]
                if not escs:
                    rejected = [r for r in mine if r.get("kind") in (ATTACH, CREATE_BOOK)
                                and r.get("state") == REJECTED]
                    if not rejected:
                        continue
                    rec = rejected[-1]
                    argument = (rec.get("review") or {}).get("argument") or "reviewer did not rule"
                    question = ("The reviewer did not rule on this proposal before the run ended."
                                if argument == "reviewer did not rule"
                                else f"The reviewer objected: {argument}")
                    esc_id, _payload = self._reject_and_escalate(rec, argument=argument, question=question)
                    escs = [self.store.get(esc_id)]
                wd = []
                for e in escs:
                    wd = would_do(e["payload"], index=index)
                    if e.get("state") == PROPOSED_I:
                        self.store.record(e["intent_id"], SIMULATED_I, would_do=wd)
                self.arrivals.record(key, NEEDS_DECISION, would_do=wd, human_answer=None)

    def finalize_dry_run(self, run_id: str, index=None, only_arrivals=None) -> None:
        """Turn this run's accepted intents into arrival-visible "would do"
        plans. `index` is the LibraryIndex snapshot used to resolve an
        attach's target folder -- safe to reuse the run's own index since
        DRY_RUN never writes to BookOrbit, so nothing has changed underneath
        it since the run started. `only_arrivals` (Plan 2 Task 4) limits the
        pass to those arrival keys -- the live finalize handles the rest.
        """
        with self.lock:
            self._finalize(run_id, index, only_arrivals, live=False, now=None)

    def finalize_live(self, run_id: str, index=None, only_arrivals=None, now=None) -> list:
        """The live counterpart of `finalize_dry_run` for arrivals whose
        source executes for real. Everything but an APPROVED filing is
        finalized exactly as in dry-run (escalations, deferrals, unruled
        proposals -- "as P1"). An approved attach/create_book is QUEUED: its
        arrival becomes `retryable` with `attempts=0`, `retry_at=now` and
        `exec_intent` naming the intent, which stays `approved` until the
        service executes it (app/execution.py) -- never re-offered to the
        LLM. An approved update_metadata whose attach will file also stays
        `approved`: it runs right after that filing. Returns the queued keys.
        """
        with self.lock:
            return self._finalize(run_id, index, only_arrivals, live=True,
                                  now=self.clock() if now is None else now)

    def _finalize(self, run_id, index, only_arrivals, *, live, now) -> list:
        queued = []
        for rec in [r for r in self.store.all() if r.get("run_id") == run_id]:
            if only_arrivals is not None and rec.get("arrival") not in only_arrivals:
                continue
            kind = rec.get("kind")
            state = rec.get("state")

            if kind in (ATTACH, CREATE_BOOK):
                if state == APPROVED:
                    wd = would_do(rec["payload"], index=index)
                    if live:
                        self.arrivals.record(rec["arrival"], RETRYABLE, exec_intent=rec["intent_id"],
                                             attempts=0, retry_at=now, would_do=wd,
                                             detail="queued for execution")
                        queued.append(rec["arrival"])
                    else:
                        self.store.record(rec["intent_id"], SIMULATED_I, would_do=wd)
                        self.arrivals.record(rec["arrival"], SIMULATED, would_do=wd)
                elif state == PROPOSED_I:
                    esc_id, esc_payload = self._reject_and_escalate(
                        rec, argument="reviewer did not rule",
                        question="The reviewer did not rule on this proposal before the run ended.",
                    )
                    self._cascade_reject_metadata(rec)
                    wd = would_do(esc_payload, index=index)
                    self.store.record(esc_id, SIMULATED_I, would_do=wd)
                    self.arrivals.record(rec["arrival"], NEEDS_DECISION, would_do=wd, human_answer=None)

            elif kind == UPDATE_METADATA:
                # Re-read: an earlier iteration this same pass may have
                # already cascaded a reject from this arrival's attach
                # (attach is always submitted, hence stored, before its
                # update_metadata -- see IntentBook.submit).
                cur_state = (self.store.get(rec["intent_id"]) or {}).get("state")
                if cur_state == APPROVED:
                    # Fix round 1, Minor #6: don't just trust that the
                    # cascade above already ran (which relies on
                    # iteration order) -- explicitly require the SAME
                    # arrival's SAME-run attach to itself be
                    # APPROVED/SIMULATED_I (i.e. it will, or already
                    # did, actually file) before simulating the patch.
                    if not self._attach_ok_for(rec):
                        self.store.record(rec["intent_id"], REJECTED, review={
                            "verdict": "reject", "argument": "paired attach is not approved",
                        })
                    elif not live:
                        wd = would_do(rec["payload"], index=index)
                        self.store.record(rec["intent_id"], SIMULATED_I, would_do=wd)
                    # live: stays APPROVED; executed after its attach files
                elif cur_state == PROPOSED_I:
                    # Never ruled on: dropped silently, same as an
                    # explicit reviewer reject -- no auto-escalation.
                    self.store.record(rec["intent_id"], REJECTED,
                                      review={"verdict": "reject", "argument": "reviewer did not rule"})

            elif kind == ESCALATE and state == PROPOSED_I:
                wd = would_do(rec["payload"], index=index)
                self.store.record(rec["intent_id"], SIMULATED_I, would_do=wd)
                self.arrivals.record(rec["arrival"], NEEDS_DECISION, would_do=wd, human_answer=None)

            elif kind == DEFER and state == PROPOSED_I:
                # the arrival was already recorded DEFERRED with its
                # not_before at submit time -- only the intent moves.
                wd = would_do(rec["payload"], index=index)
                self.store.record(rec["intent_id"], SIMULATED_I, would_do=wd)
        return queued


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
    if kind == UPDATE_METADATA:
        return _would_do_update_metadata(intent)
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


def _would_do_update_metadata(intent: dict) -> list:
    """Fix round 1, Important: built from the MAPPED PATCH keys
    (`app.bookmeta.update_metadata_fields`), not the intent's raw metadata
    keys -- e.g. `series` shows up as `seriesName`, and a rejected-at-guard
    key (`narrators`/`asinTag`) can never appear here, so the plan always
    describes what the executor will actually send."""
    mapped = bookmeta.update_metadata_fields(intent.get("metadata") or {})
    keys = sorted(mapped.keys())
    lock = intent.get("lock") or []
    return [
        f"patch metadata of book {intent['book_id']}: {', '.join(keys)}",
        f"lock: {', '.join(lock)}",
    ]
