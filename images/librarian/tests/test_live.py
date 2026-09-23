"""Plan 2 Task 4: live finalize, LIVE_SOURCES gating, retries, startup
resume, and the dry-run -> live transition.

Service-level behaviour is driven with a scripted `FakeExecutor`; the last
test wires the REAL Executor over the fake BookOrbit transport from
tests/test_executor.py end to end (arrival -> fake LLM -> reviewer approve ->
live execution -> FILED, intake cleaned, library tree only gained files).
"""
import copy
import json
import logging
import os

import pytest

from app import states
from app.bookorbit import BookorbitClient, BookorbitWriter, LibraryIndex
from app.executor import ExecResult, Executor
from app.service import Service
from tests.test_executor import FakeBookorbit, FakeClock
from tests.test_service import (
    ASIN,
    BOOKS,
    Clock,
    FakeModel,
    add_libation,
    approve_all,
    attach_script,
    fake_prober,
    make_index,
    make_settings,
    q,
)


class Crash(BaseException):
    """Simulated process death."""


def filed(book_id=2, escalate=None, detail="filed into book 2"):
    return ExecResult(True, "filed", book_id, detail, [], escalate)


def retryable(detail="scan still running"):
    return ExecResult(False, "retryable", None, f"nothing moved: {detail}")


def failed(detail="linked /intake/x.m4b -> /media/books/y/x.m4b but hash differs"):
    return ExecResult(False, "failed", None, detail)


class FakeExecutor:
    def __init__(self, results=(), update_results=(), resume_result=None):
        self.results = list(results)
        self.update_results = list(update_results)
        self.resume_result = resume_result or filed()
        self.calls = []        # (intent_id, key, arrival state at call time)
        self.resumed = []
        self.updates = []

    def execute(self, intent, arrival_rec, dossier=None):
        self.calls.append((intent["intent_id"], arrival_rec["key"], arrival_rec["state"]))
        assert dossier is not None and dossier["key"] == arrival_rec["key"]
        r = self.results.pop(0) if self.results else filed()
        return r(intent, arrival_rec) if callable(r) else r

    def resume(self, rec):
        self.resumed.append(rec["key"])
        return self.resume_result

    def execute_update(self, intent, arrival_rec, book_id):
        self.updates.append((intent["intent_id"], arrival_rec["key"], book_id))
        if self.update_results:
            return self.update_results.pop(0)
        return ExecResult(True, "updated", book_id, "patched")


@pytest.fixture
def live_factory(tmp_path):
    made = []

    def make(model=None, fx=None, clock=None, books=BOOKS, **kw):
        kw.setdefault("dry_run", False)
        s = Service(make_settings(tmp_path, **kw), index=make_index(tmp_path, books=books),
                    runner=model or FakeModel(), prober=fake_prober, clock=clock or Clock(),
                    executor=fx)
        made.append(s)
        return s

    yield make
    for s in made:
        s.stop()


def drive(svc, clock, steps=(0, 1, 11)):
    for dt in steps:
        clock.t += dt
        svc.tick()


def only_key(svc):
    recs = svc.arrivals.all()
    assert len(recs) == 1, recs
    return recs[0]["key"]


def filing_intent(svc, key):
    recs = [r for r in svc.intents.store.all()
            if r["arrival"] == key and r["kind"] in (states.ATTACH, states.CREATE_BOOK)]
    assert len(recs) == 1, recs
    return recs[0]


def executor_escalations(svc, key):
    return [r for r in svc.intents.store.all()
            if r["kind"] == states.ESCALATE and r["arrival"] == key
            and (r.get("payload") or {}).get("origin") == "executor"]


def create_script(call):
    st, arrivals = call("GET", "/arrivals")
    assert st == 200, arrivals
    for i, a in enumerate(sorted(arrivals, key=lambda a: a["key"])):
        call("GET", f"/arrivals/{q(a['key'])}")
        st, body = call("POST", "/intents", {
            "kind": "create_book", "arrival": a["key"], "library": "adult",
            "metadata": {"title": f"Book {i}", "authors": ["Some Author"]}, "reason": "new"})
        assert st == 200 and body["status"] == states.PROPOSED_I, body


# --- construction ------------------------------------------------------------------


def test_live_mode_needs_an_executor(tmp_path):
    with pytest.raises(ValueError):
        Service(make_settings(tmp_path, dry_run=False), index=make_index(tmp_path),
                runner=FakeModel(), prober=fake_prober)


def test_dry_run_never_builds_the_executor(tmp_path):
    built = []
    s = Service(make_settings(tmp_path), index=make_index(tmp_path), runner=FakeModel(),
                prober=fake_prober, executor=lambda svc: built.append(svc))
    try:
        assert built == [] and s.executor is None
    finally:
        s.stop()


def test_executor_factory_gets_the_service(tmp_path, live_factory):
    seen = []

    def factory(svc):
        seen.append(svc)
        return FakeExecutor()

    svc = live_factory(fx=factory)
    assert seen == [svc] and isinstance(svc.executor, FakeExecutor)


# --- the live filing path ------------------------------------------------------------


def test_live_attach_files_the_arrival(tmp_path, live_factory, caplog):
    caplog.set_level(logging.INFO)
    fx = FakeExecutor()
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)

    key = only_key(svc)
    intent = filing_intent(svc, key)
    assert fx.calls == [(intent["intent_id"], key, states.EXECUTING)]
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.FILED and rec["book_id"] == 2
    assert rec["sha256"] and key.endswith(rec["sha256"][:12])
    assert svc.intents.store.get(intent["intent_id"])["state"] == states.EXECUTED
    assert "Librarian: 1 filed · 0 need a decision · 0 failed" in caplog.text
    assert '🎧 Artificial Condition — added to "Artificial Condition"' in caplog.text
    # the run's end record precedes execution and does not claim a dry-run
    with open(svc.runs_path) as f:
        ends = [json.loads(line) for line in f if '"outcome"' in line]
    assert ends[-1]["outcome"] == "ok" and ends[-1]["failed"] is False


def test_filed_hash_makes_a_later_copy_a_duplicate(tmp_path, live_factory):
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), FakeExecutor())
    clock = svc.clock
    add_libation(tmp_path)
    drive(svc, clock)
    manual = tmp_path / "intake" / "manual"
    manual.mkdir(parents=True, exist_ok=True)
    (manual / "copy.m4b").write_bytes(b"AUDIO" * 100)
    drive(svc, clock, (1, 1))
    dup = [r for r in svc.arrivals.all() if r["source"] == "manual"]
    assert [(r["state"], r["book_id"]) for r in dup] == [(states.DUPLICATE, 2)]


def test_live_sources_gates_execution(tmp_path, live_factory):
    fx = FakeExecutor()
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock,
                       live_sources=frozenset({"manual"}))
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    assert fx.calls == []
    assert svc.arrivals.get(key)["state"] == states.SIMULATED
    assert filing_intent(svc, key)["state"] == states.SIMULATED_I


def test_escalate_flag_files_and_escalates(tmp_path, live_factory):
    fx = FakeExecutor([filed(escalate="rename-files skipped for book 2: collision")])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.FILED
    esc = executor_escalations(svc, key)
    assert len(esc) == 1 and "rename-files skipped" in esc[0]["payload"]["question"]


def test_failed_execution_fails_arrival_and_escalates_with_paths(tmp_path, live_factory, caplog):
    caplog.set_level(logging.INFO)
    fx = FakeExecutor([failed()])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.FAILED and "/media/books/y/x.m4b" in rec["error"]
    assert filing_intent(svc, key)["state"] == states.EXEC_FAILED
    esc = executor_escalations(svc, key)
    assert len(esc) == 1 and "/media/books/y/x.m4b" in esc[0]["payload"]["question"]
    assert "⚠️ Artificial Condition — failed, see task" in caplog.text
    assert "0 filed · 0 need a decision · 1 failed" in caplog.text


# --- retries ------------------------------------------------------------------------------


def test_retryable_backs_off_exponentially_and_reexecutes_without_the_llm(tmp_path, live_factory):
    fx = FakeExecutor([retryable(), retryable(), filed()])
    clock = Clock()
    model = FakeModel(librarian=attach_script(), reviewer=approve_all)
    svc = live_factory(model, fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    t0 = clock.t
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.RETRYABLE and rec["attempts"] == 1
    assert rec["retry_at"] == t0 + 3600
    assert filing_intent(svc, key)["state"] == states.APPROVED

    clock.t += 3599
    svc.tick()
    assert len(fx.calls) == 1                         # not yet due
    clock.t += 1
    svc.tick()
    assert len(fx.calls) == 2
    rec = svc.arrivals.get(key)
    assert rec["attempts"] == 2 and rec["retry_at"] == clock.t + 7200

    clock.t += 7200
    svc.tick()
    assert len(fx.calls) == 3
    assert svc.arrivals.get(key)["state"] == states.FILED
    assert model.calls == ["librarian", "reviewer"]   # never re-offered to the LLM


def test_backoff_is_capped_at_24h(tmp_path, live_factory):
    fx = FakeExecutor([retryable(), retryable()])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock,
                       retry_after=50000)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    clock.t += 50000
    svc.tick()
    assert svc.arrivals.get(key)["retry_at"] == clock.t + 86400


def test_max_attempts_fails_and_escalates(tmp_path, live_factory):
    fx = FakeExecutor([retryable()] * 10)
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    for _ in range(8):
        clock.t += 86400
        svc.tick()
    assert len(fx.calls) == 5
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.FAILED and "5 attempts" in rec["error"]
    assert filing_intent(svc, key)["state"] == states.EXEC_FAILED
    assert len(executor_escalations(svc, key)) == 1


def test_stop_during_execution_is_not_an_attempt(tmp_path, live_factory):
    clock = Clock()
    svc = None

    def stop_then_retry(intent, rec):
        svc._stop.set()
        return retryable("service stopping")

    fx = FakeExecutor([stop_then_retry])
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    rec = svc.arrivals.get(only_key(svc))
    assert rec["state"] == states.RETRYABLE and rec["attempts"] == 0
    assert rec["retry_at"] <= clock.t


# --- pre-execution re-checks ------------------------------------------------------------------


def test_guard_recheck_before_execution_escalates(tmp_path, live_factory):
    books = copy.deepcopy(BOOKS)
    fx = FakeExecutor([retryable()])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock,
                       books=books)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    # the target book gained an m4b meanwhile: guard 5 now refuses
    books[2]["files"].append({"format": "m4b", "filename": "x.m4b", "sizeBytes": 9})
    books[2]["updatedAt"] = "t3"
    clock.t += 3600
    svc.tick()
    assert len(fx.calls) == 1
    intent = filing_intent(svc, key)
    assert intent["state"] == states.EXEC_FAILED and "m4b" in intent["exec_detail"]
    assert svc.arrivals.get(key)["state"] == states.NEEDS_DECISION
    assert len(executor_escalations(svc, key)) == 1


def test_intake_copy_gone_before_execution_fails(tmp_path, live_factory):
    import shutil
    fx = FakeExecutor([retryable()])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all), fx, clock)
    folder = add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    shutil.rmtree(folder)
    clock.t += 3600
    svc.tick()
    assert len(fx.calls) == 1
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.FAILED and "intake copy changed or gone" in rec["error"]
    assert filing_intent(svc, key)["state"] == states.EXEC_FAILED


# --- tick budget + stop --------------------------------------------------------------------------


def _two_manual(tmp_path):
    m = tmp_path / "intake" / "manual"
    m.mkdir(parents=True, exist_ok=True)
    (m / "one.m4b").write_bytes(b"ONE" * 100)
    (m / "two.m4b").write_bytes(b"TWO" * 100)


def test_max_exec_per_tick(tmp_path, live_factory):
    fx = FakeExecutor()
    clock = Clock()
    svc = live_factory(FakeModel(librarian=create_script, reviewer=approve_all), fx, clock,
                       max_exec_per_tick=1)
    _two_manual(tmp_path)
    drive(svc, clock)
    assert len(fx.calls) == 1
    assert sorted(r["state"] for r in svc.arrivals.all()) == [states.FILED, states.RETRYABLE]
    clock.t += 1
    svc.tick()
    assert len(fx.calls) == 2
    assert [r["state"] for r in svc.arrivals.all()] == [states.FILED, states.FILED]


def test_stop_flag_checked_between_intents(tmp_path, live_factory):
    clock = Clock()
    svc = None

    def file_then_stop(intent, rec):
        svc._stop.set()
        return filed(book_id=1001)

    fx = FakeExecutor([file_then_stop])
    svc = live_factory(FakeModel(librarian=create_script, reviewer=approve_all), fx, clock)
    _two_manual(tmp_path)
    drive(svc, clock)
    assert len(fx.calls) == 1
    assert sorted(r["state"] for r in svc.arrivals.all()) == [states.FILED, states.RETRYABLE]


# --- update_metadata after the filing ----------------------------------------------------------


def attach_and_update_script(call):
    attach_script()(call)
    st, arrivals = call("GET", "/arrivals")
    for a in arrivals:
        st, body = call("POST", "/intents", {
            "kind": "update_metadata", "arrival": a["key"], "book_id": 2,
            "metadata": {"series": "The Murderbot Diaries"}, "lock": [], "reason": "series"})
        assert st == 200 and body["status"] == states.PROPOSED_I, body


def test_update_metadata_runs_after_filing(tmp_path, live_factory):
    fx = FakeExecutor()
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_and_update_script, reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    meta = [r for r in svc.intents.store.all() if r["kind"] == states.UPDATE_METADATA]
    assert fx.updates == [(meta[0]["intent_id"], key, 2)]
    assert svc.intents.store.get(meta[0]["intent_id"])["state"] == states.EXECUTED


def test_update_metadata_failure_escalates_but_filing_stands(tmp_path, live_factory):
    fx = FakeExecutor(update_results=[ExecResult(False, "failed", 2, "read-back mismatch: seriesName")])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_and_update_script, reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    key = only_key(svc)
    meta = [r for r in svc.intents.store.all() if r["kind"] == states.UPDATE_METADATA]
    assert svc.intents.store.get(meta[0]["intent_id"])["state"] == states.EXEC_FAILED
    assert svc.arrivals.get(key)["state"] == states.FILED
    esc = executor_escalations(svc, key)
    assert len(esc) == 1 and "seriesName" in esc[0]["payload"]["question"]


def test_failed_filing_rejects_its_update_metadata(tmp_path, live_factory):
    fx = FakeExecutor([failed()])
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_and_update_script, reviewer=approve_all), fx, clock)
    add_libation(tmp_path)
    drive(svc, clock)
    meta = [r for r in svc.intents.store.all() if r["kind"] == states.UPDATE_METADATA]
    assert fx.updates == []
    assert svc.intents.store.get(meta[0]["intent_id"])["state"] == states.REJECTED


# --- crash safety: startup ------------------------------------------------------------------


def test_crash_before_the_journal_is_retried_after_restart(tmp_path, live_factory):
    def die(intent, rec):
        raise Crash()

    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor([die]), clock)
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.EXECUTING
    svc.stop()

    fx2 = FakeExecutor()
    svc2 = live_factory(FakeModel(), fx2, clock)
    intent = filing_intent(svc2, key)
    assert intent["state"] == states.APPROVED           # recovery left it alone
    svc2.tick()
    assert fx2.resumed == []                            # no journal: nothing to resume
    assert len(fx2.calls) == 1
    assert svc2.arrivals.get(key)["state"] == states.FILED


def test_executing_arrival_with_journal_is_resumed_on_startup(tmp_path, live_factory):
    svc = None

    def die_mid_move(intent, rec):
        svc.arrivals.record(rec["key"], states.EXECUTING,
                            exec={"intent_id": intent["intent_id"], "open": True, "step": "scanned"})
        raise Crash()

    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor([die_mid_move]), clock)
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    svc.stop()

    fx2 = FakeExecutor(resume_result=filed())
    svc2 = live_factory(FakeModel(), fx2, clock)
    svc2.tick()
    assert fx2.resumed == [key] and fx2.calls == []
    assert svc2.arrivals.get(key)["state"] == states.FILED
    assert filing_intent(svc2, key)["state"] == states.EXECUTED


def test_dry_run_leaves_executing_arrivals_alone(tmp_path, live_factory):
    def die(intent, rec):
        raise Crash()

    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor([die]), clock)
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    svc.stop()
    svc2 = live_factory(FakeModel(), None, clock, dry_run=True)     # rollback
    svc2.tick()
    assert svc2.arrivals.get(key)["state"] == states.EXECUTING
    assert filing_intent(svc2, key)["state"] == states.APPROVED


def test_crash_between_end_record_and_finalize_completes_on_restart(tmp_path, live_factory):
    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor(), clock)

    def die(*a, **kw):
        raise Crash()

    svc.intents.finalize_live = die
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.PROPOSED
    svc.stop()

    fx2 = FakeExecutor()
    svc2 = live_factory(FakeModel(), fx2, clock)
    assert filing_intent(svc2, key)["state"] == states.APPROVED
    svc2.tick()
    assert len(fx2.calls) == 1
    assert svc2.arrivals.get(key)["state"] == states.FILED


# --- dry-run -> live transition ---------------------------------------------------------------


def test_dry_run_to_live_reoffers_simulated_arrivals_per_source(tmp_path, live_factory):
    import hashlib
    clock = Clock()
    dry = live_factory(FakeModel(), None, clock, dry_run=True)

    def simulated(source, sid, data, keep=True):
        p = tmp_path / "files" / f"{sid}.m4b"
        p.parent.mkdir(exist_ok=True)
        p.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        key = f"{source}:{sid}:{sha[:12]}"
        dry.arrivals.record(key, states.SIMULATED, source=source, source_id=sid,
                            path=str(p), primary=str(p), sha256=sha)
        if keep == "changed":
            p.write_bytes(data + b"x")
        elif not keep:
            p.unlink()
        return key

    kept = simulated("libation", "B0KEPT", b"K" * 10)
    gone = simulated("libation", "B0GONE", b"G" * 10, keep=False)
    changed = simulated("manual", "changed", b"C" * 10, keep="changed")
    kindle = simulated("kindle", "B0KINDLE", b"E" * 10, keep=False)   # not in LIVE_SOURCES
    dry.stop()

    live = live_factory(FakeModel(), FakeExecutor(), clock)
    live.tick()
    assert live.arrivals.get(kept)["state"] == states.READY
    assert "re-offered for live" in live.arrivals.get(kept)["detail"]
    for k in (gone, changed):
        assert live.arrivals.get(k)["state"] == states.FAILED, k
        assert live.arrivals.get(k)["error"] == "intake copy gone"
    assert live.arrivals.get(kindle)["state"] == states.SIMULATED
    sd = live.settings.state_dir
    assert os.path.exists(os.path.join(sd, "live-since-libation"))
    assert os.path.exists(os.path.join(sd, "live-since-manual"))
    assert not os.path.exists(os.path.join(sd, "live-since-kindle"))
    live.stop()

    # the marker makes it once-only: a later simulated libation arrival stays simulated
    later = simulated("libation", "B0LATER", b"L" * 10)
    again = live_factory(FakeModel(), FakeExecutor(), clock)
    again.tick()
    assert again.arrivals.get(later)["state"] == states.SIMULATED


# --- integration: the real Executor over the fake BookOrbit ----------------------------------


INTEGRATION_TAGS = {
    "format": {"duration": "40000",
               "tags": {"title": "Artificial Condition", "artist": "Martha Wells",
                        "audible_asin": ASIN}},
    "chapters": [{"tags": {"title": "Chapter 1"}}],
}


def test_end_to_end_live_attach_with_real_executor(tmp_path):
    books_root = tmp_path / "media" / "books"
    (books_root / "Library").mkdir(parents=True)
    (books_root / "Kids Audiobooks").mkdir(parents=True)
    fake = FakeBookorbit(books_root)
    fake.add_book(2, 7, "Martha Wells/Artificial Condition", "Artificial Condition", ["Martha Wells"],
                  files=(("Artificial Condition.epub", b"epub-bytes"),),
                  providerIds={"audible": ASIN})
    fclock = FakeClock()

    ro = BookorbitClient("http://b/api/v1", "u", "p", transport=fake.transport,
                         cookie_path=str(tmp_path / "ro.txt"), clock=fclock)
    ro.authenticate()
    index = LibraryIndex(ro, str(tmp_path / "idx.json"), path_prefix="/books",
                         local_root=str(books_root))
    index.refresh(now=0, force=True)
    wc = BookorbitClient("http://b/api/v1", "u", "p", transport=fake.transport,
                         cookie_path=str(tmp_path / "w.txt"), clock=fclock, writable=True)
    wc.authenticate()
    writer = BookorbitWriter(wc)
    settings = make_settings(tmp_path, dry_run=False)

    def factory(svc):
        return Executor(svc.settings, writer, svc.index, svc.arrivals, clock=fclock,
                        sleep=fclock.sleep, stopping=svc.stopping)

    def before_tree():
        out = {}
        for dirpath, _d, files in os.walk(books_root):
            out[dirpath] = None
            for f in files:
                p = os.path.join(dirpath, f)
                st = os.stat(p)
                out[p] = (st.st_ino, st.st_size, st.st_mtime_ns)
        return out

    model = FakeModel(librarian=attach_script(book_id=2), reviewer=approve_all)
    clock = Clock()
    svc = Service(settings, index=index, runner=model, prober=lambda _p: INTEGRATION_TAGS,
                  clock=clock, executor=factory)
    try:
        folder = add_libation(tmp_path)
        tree0 = before_tree()
        drive(svc, clock)
        key = only_key(svc)
        rec = svc.arrivals.get(key)
        assert rec["state"] == states.FILED, rec
        assert rec["book_id"] == 2
        assert filing_intent(svc, key)["state"] == states.EXECUTED
        # intake cleaned; the library only gained files
        assert not folder.exists()
        tree1 = before_tree()
        for p, sig in tree0.items():
            assert tree1.get(p, "missing") == sig, p
        gained = sorted(set(tree1) - set(tree0))
        assert gained == [str(books_root / "Library" / "Martha Wells" / "Artificial Condition"
                              / "Artificial Condition.m4b")]
        assert len(fake.scans()) == 1 and len(fake.renames()) == 1
    finally:
        svc.stop()


def test_torn_end_record_never_rejects_executor_owned_intents(tmp_path, live_factory):
    def die(intent, rec):
        raise Crash()

    clock = Clock()
    svc = live_factory(FakeModel(librarian=attach_script(), reviewer=approve_all),
                       FakeExecutor([die]), clock)
    add_libation(tmp_path)
    with pytest.raises(Crash):
        drive(svc, clock)
    key = only_key(svc)
    svc.stop()
    with open(svc.runs_path, "rb") as f:
        data = f.read()
    with open(svc.runs_path, "wb") as f:
        f.write(data[:-20])                          # the end record is torn

    fx2 = FakeExecutor()
    svc2 = live_factory(FakeModel(), fx2, clock)
    assert filing_intent(svc2, key)["state"] == states.APPROVED
    assert svc2.arrivals.get(key)["state"] == states.EXECUTING
    svc2.tick()
    assert svc2.arrivals.get(key)["state"] == states.FILED
