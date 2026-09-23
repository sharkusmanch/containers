"""Tests for app/service.py (+ app/runs.py, app/metrics.py): the poll loop.

A fake runner stands in for `claude -p` and "plays the model": it reads the
internal API URL and run token out of the `--mcp-config` JSON in argv (the
exact config the real shim would be launched with) and drives the real
`ApiServer` over HTTP with urllib, then writes a stream-json transcript whose
system/init line grants only mcp__librarian__* tools -- so the service's
containment tripwire passes -- unless a test asks it to grant "Bash".
"""
import hashlib
import json
import logging
import os
import time
import urllib.error
import urllib.request

import pytest
from prometheus_client import REGISTRY

from app import states
from app.bookorbit import BookorbitClient, LibraryIndex
from app.config import Settings
from app.runner import RunResult
from app.service import Service, Stopping
from tests.test_bookorbit import fake_transport

ASIN = "B0MURDERB0T"

BOOKS = {
    2: {
        "id": 2, "title": "Artificial Condition", "subtitle": None,
        "authors": [{"id": 2, "name": "Martha Wells", "sortName": "Wells, Martha"}],
        "providerIds": {"audible": ASIN}, "tags": [], "isbn13": None, "isbn10": None,
        "libraryName": "Library", "seriesName": "Murderbot Diaries", "seriesIndex": 2,
        "publishedYear": 2018, "readAloudSync": {"state": "unavailable"},
        "folderPath": "/books/Library/Martha Wells/Artificial Condition",
        "files": [{"format": "epub", "filename": "ac.epub", "sizeBytes": 5}],
        "updatedAt": "t2",
    },
}

TAGS = {
    "format": {
        "duration": "40000",
        "tags": {
            "title": "Artificial Condition", "artist": "Martha Wells",
            "series": "Murderbot Diaries", "series-part": "2", "audible_asin": ASIN,
        },
    },
    "chapters": [{"tags": {"title": "Chapter 1"}}],
}


def fake_prober(_path):
    return TAGS


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


# --- the fake model --------------------------------------------------------


class FakeModel:
    """A `runner=` stand-in. `scripts[mode]` is called with a `call(method,
    path, body=None)` helper bound to this run's API + token."""

    def __init__(self, librarian=None, reviewer=None, grant=("mcp__librarian__list_arrivals",),
                 timed_out=False):
        self.scripts = {"librarian": librarian, "reviewer": reviewer}
        self.grant = list(grant)
        self.timed_out = timed_out
        self.calls = []  # modes, in order

    def __call__(self, argv, *, cwd, env, timeout, transcript_path, on_tick=None, **_kw):
        cfg = json.loads(argv[argv.index("--mcp-config") + 1])
        senv = cfg["mcpServers"]["librarian"]["env"]
        api, token, mode = senv["LIBRARIAN_API"], senv["LIBRARIAN_RUN_TOKEN"], senv["LIBRARIAN_MODE"]
        self.calls.append(mode)
        assert os.path.isdir(cwd)
        assert os.path.isdir(env["CLAUDE_CONFIG_DIR"])
        assert "BOOKORBIT_PASS" not in env

        def call(method, path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(api + path, data=data, method=method, headers={
                "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")

        script = self.scripts.get(mode)
        if script is not None:
            script(call)

        os.makedirs(os.path.dirname(transcript_path), exist_ok=True)
        with open(transcript_path, "w") as f:
            f.write(json.dumps({"type": "system", "subtype": "init", "tools": self.grant}) + "\n")
            if not self.timed_out:
                f.write(json.dumps({"type": "result", "is_error": False, "result": "done",
                                    "total_cost_usd": 0.25, "num_turns": 3}) + "\n")
        return RunResult(
            ok=not self.timed_out, exit_code=None if self.timed_out else 0,
            timed_out=self.timed_out, result_text="" if self.timed_out else "done",
            cost_usd=None if self.timed_out else 0.25, usage={},
            num_turns=None if self.timed_out else 3, transcript_path=transcript_path,
            error_reason="result_missing" if self.timed_out else None,
        )


def q(key):
    return urllib.request.quote(key, safe="")


def attach_script(book_id=2):
    def script(call):
        st, arrivals = call("GET", "/arrivals")
        assert st == 200, arrivals
        for a in arrivals:
            call("GET", f"/arrivals/{q(a['key'])}")
            call("POST", "/intents", {"kind": "attach", "arrival": a["key"], "book_id": book_id,
                                      "reason": "same audible asin"})
    return script


def approve_all(call):
    st, props = call("GET", "/proposals")
    assert st == 200, props
    for p in props:
        st, body = call("POST", "/reviews", {"intent_id": p["intent_id"], "verdict": "approve",
                                             "argument": "asin matches"})
        assert st == 200, body


# --- fixture wiring --------------------------------------------------------


def make_settings(tmp_path, **kw):
    prompts = tmp_path / "prompts"
    prompts.mkdir(exist_ok=True)
    (prompts / "librarian.md").write_text("You are the librarian.\n")
    (prompts / "reviewer.md").write_text("You are the reviewer.\n")
    base = dict(
        bookorbit_url="http://b/api/v1", bookorbit_user="u", bookorbit_pass="p",
        intake_root=str(tmp_path / "intake"), local_books_root=str(tmp_path / "media" / "books"),
        state_dir=str(tmp_path / "state"), lists_dir=str(tmp_path / "lists"),
        prompts_dir=str(prompts), quiet_period=0, debounce=10, api_port=0,
        runs_root=str(tmp_path / "runs"), retry_after=3600,
    )
    base.update(kw)
    return Settings(**base)


def make_index(tmp_path, books=BOOKS):
    c = BookorbitClient("http://b/api/v1", "u", "p", transport=fake_transport([], books=books),
                        cookie_path=str(tmp_path / "c.txt"))
    c.authenticate()
    idx = LibraryIndex(c, state_path=str(tmp_path / "idx.json"),
                       local_root=str(tmp_path / "media" / "books"))
    idx.refresh(now=0, force=True)
    return idx


def add_libation(tmp_path, asin=ASIN, data=b"AUDIO" * 100, title="Artificial Condition"):
    d = tmp_path / "intake" / "libation" / f"{title} [{asin}]"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{title}.m4b").write_bytes(data)
    return d


@pytest.fixture
def svc_factory(tmp_path):
    made = []

    def make(model, clock=None, **settings_kw):
        s = Service(make_settings(tmp_path, **settings_kw), index=make_index(tmp_path),
                    runner=model, prober=fake_prober, clock=clock or Clock())
        made.append(s)
        return s

    yield make
    for s in made:
        s.stop()


def only_key(svc):
    recs = svc.arrivals.all()
    assert len(recs) == 1, recs
    return recs[0]["key"]


def metric(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0.0


# --- (a) happy path ----------------------------------------------------------


def test_stable_arrival_runs_librarian_then_reviewer_and_simulates(tmp_path, svc_factory, caplog):
    caplog.set_level(logging.INFO)
    model = FakeModel(librarian=attach_script(), reviewer=approve_all)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    before_ok = metric("librarian_runs_total", mode="librarian", outcome="ok")

    svc.tick()                       # first sighting: not yet stable
    assert svc.arrivals.all() == []
    clock.t += 1
    svc.tick()                       # stable -> hashed, dossier, READY; debounce not elapsed
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    assert svc.load_dossier(key)["key"] == key
    dossier_file = os.path.join(svc.settings.state_dir, "dossiers",
                                hashlib.sha256(key.encode()).hexdigest()[:24] + ".json")
    assert os.path.exists(dossier_file)
    assert model.calls == []

    clock.t += 11
    svc.tick()
    assert model.calls == ["librarian", "reviewer"]
    rec = svc.arrivals.get(key)
    assert rec["state"] == states.SIMULATED
    assert any("mv <primary>" in step for step in rec["would_do"])
    assert svc.current_run() is None

    # run record + summary text
    with open(os.path.join(svc.settings.state_dir, "runs.jsonl")) as f:
        lines = [json.loads(line) for line in f]
    assert [r["event"] for r in lines] == ["start", "end"]
    assert lines[0]["keys"] == [key] and lines[0]["run_id"] == lines[1]["run_id"]
    runs = lines[1:]
    assert runs[0]["keys"] == [key]
    assert runs[0]["librarian"]["ok"] is True and runs[0]["reviewer"]["cost_usd"] == 0.25
    assert "Librarian (dry-run): 1 would file · 0 would escalate" in caplog.text
    assert 'would add to "Artificial Condition"' in caplog.text

    # metrics
    assert metric("librarian_runs_total", mode="librarian", outcome="ok") == before_ok + 1
    assert metric("librarian_arrivals", state=states.SIMULATED) == 1
    assert metric("librarian_index_books") == 1
    assert metric("librarian_heartbeat_timestamp") > 0


# --- (b) no change -> no run -------------------------------------------------


def test_second_tick_without_changes_starts_no_run(tmp_path, svc_factory):
    model = FakeModel(librarian=lambda call: None)   # librarian does nothing at all
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]              # no proposals -> no reviewer
    for _ in range(5):
        clock.t += 500
        svc.tick()
    assert model.calls == ["librarian"]
    assert svc.arrivals.get(only_key(svc))["state"] == states.READY


def test_burst_of_arrivals_is_one_run(tmp_path, svc_factory):
    model = FakeModel(librarian=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    svc.tick()
    clock.t += 1
    svc.tick()
    add_libation(tmp_path, asin="B0SECOND00", data=b"OTHER" * 50, title="Second")
    clock.t += 5
    svc.tick()
    clock.t += 1
    svc.tick()                        # second one READY now, newest change is fresh
    assert model.calls == []
    clock.t += 11
    svc.tick()
    assert model.calls == ["librarian"]
    assert len(svc.arrivals.all()) == 2


# --- (c) reviewer never rules -----------------------------------------------


def test_reviewer_never_rules_rejects_and_needs_decision(tmp_path, svc_factory):
    model = FakeModel(librarian=attach_script(), reviewer=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian", "reviewer"]
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.NEEDS_DECISION
    filing = [r for r in svc.intents.store.all() if r["kind"] == states.ATTACH]
    assert [r["state"] for r in filing] == [states.REJECTED]
    assert filing[0]["review"]["argument"] == "reviewer did not rule"


# --- (d) guard-rejected only ------------------------------------------------


def test_guard_rejected_only_run_does_not_reoffer_until_change(tmp_path, svc_factory):
    model = FakeModel(librarian=attach_script(book_id=999))    # not in the library
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    key = only_key(svc)
    assert [r["state"] for r in svc.intents.store.all()] == [states.GUARD_REJECTED]
    assert svc.arrivals.get(key)["state"] == states.READY
    for _ in range(3):
        clock.t += 4000                                      # well past retry_after too
        svc.tick()
    assert model.calls == ["librarian"]


# --- (e) duplicate bytes -----------------------------------------------------


def test_duplicate_bytes_of_filed_arrival(tmp_path, svc_factory):
    model = FakeModel()
    clock = Clock()
    svc = svc_factory(model, clock)
    data = b"AUDIO" * 100
    sha = hashlib.sha256(data).hexdigest()
    svc.arrivals.record(f"libation:B0OLDCOPY0:{sha[:12]}", states.FILED, sha256=sha, book_id=2)
    add_libation(tmp_path, asin="B0NEWCOPY0", data=data)
    svc.tick()
    clock.t += 1
    svc.tick()
    dup = [r for r in svc.arrivals.all() if r["state"] == states.DUPLICATE]
    assert len(dup) == 1
    assert dup[0]["key"].startswith("libation:B0NEWCOPY0:")
    assert dup[0]["would_do"] == ["remove intake copy (identical to book 2)"]
    clock.t += 100
    svc.tick()
    assert model.calls == []


def test_kindle_sidecar_mismatch_fails_arrival(tmp_path, svc_factory):
    model = FakeModel()
    clock = Clock()
    svc = svc_factory(model, clock)
    k = tmp_path / "intake" / "kindle"
    k.mkdir(parents=True)
    (k / "B0KINDLE01.epub").write_bytes(b"not really an epub")
    (k / "B0KINDLE01.json").write_text(json.dumps({"sha256": "0" * 64, "asin": "B0KINDLE01"}))
    svc.tick()
    clock.t += 1
    svc.tick()
    rec = only_key(svc)
    assert svc.arrivals.get(rec)["state"] == states.FAILED
    assert "mismatch" in svc.arrivals.get(rec)["error"]


def test_dossier_error_leaves_candidate_unrecorded_and_retries(tmp_path, svc_factory):
    model = FakeModel()
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    real_candidates = svc.index.candidates
    boom = {"n": 1}

    def flaky(**kw):
        if boom["n"]:
            boom["n"] -= 1
            raise OSError("bookorbit down")
        return real_candidates(**kw)

    svc.index.candidates = flaky
    svc.tick()
    clock.t += 1
    svc.tick()                 # dossier raises -> nothing recorded, tick survives
    assert svc.arrivals.all() == []
    clock.t += 1
    svc.tick()
    assert svc.arrivals.get(only_key(svc))["state"] == states.READY


# --- (f) runner timeout -----------------------------------------------------


def test_timeout_retries_after_retry_after_not_every_poll(tmp_path, svc_factory):
    model = FakeModel(librarian=lambda call: None, timed_out=True)
    clock = Clock()
    svc = svc_factory(model, clock)
    before = metric("librarian_runs_total", mode="librarian", outcome="timeout")
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    assert metric("librarian_runs_total", mode="librarian", outcome="timeout") == before + 1
    with open(os.path.join(svc.settings.state_dir, "runs.jsonl")) as f:
        assert json.loads(f.readlines()[-1])["outcome"] == "timeout"

    for _ in range(5):                 # polls within the retry window: nothing
        clock.t += 120
        svc.tick()
    assert model.calls == ["librarian"]
    clock.t += 3600
    svc.tick()
    assert model.calls == ["librarian", "librarian"]


def test_timeout_discards_partial_intents(tmp_path, svc_factory):
    model = FakeModel(librarian=attach_script(), timed_out=True)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]           # no reviewer for a failed run
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    assert [r["state"] for r in svc.intents.store.all()] == [states.REJECTED]


# --- containment tripwire ----------------------------------------------------


def test_containment_tripwire_discards_run(tmp_path, svc_factory, caplog):
    model = FakeModel(librarian=attach_script(), reviewer=approve_all,
                      grant=("mcp__librarian__list_arrivals", "Bash"))
    clock = Clock()
    svc = svc_factory(model, clock)
    before = metric("librarian_runs_total", mode="librarian", outcome="containment_failed")
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    intents = svc.intents.store.all()
    assert [r["state"] for r in intents] == [states.REJECTED]
    assert intents[0]["review"]["argument"] == "containment check failed"
    assert metric("librarian_runs_total", mode="librarian", outcome="containment_failed") == before + 1
    assert any(r.levelno == logging.ERROR and "containment" in r.getMessage() for r in caplog.records)

    # the discard itself rewrote the arrival (PROPOSED -> READY); that must
    # not count as a "change" that re-offers it before retry_after
    clock.t += 600
    svc.tick()
    clock.t += 20
    svc.tick()
    assert model.calls == ["librarian"]           # not re-offered before retry_after
    clock.t += 3600
    svc.tick()
    assert model.calls == ["librarian", "librarian"]


def test_empty_granted_tools_is_containment_failure(tmp_path, svc_factory):
    model = FakeModel(librarian=lambda call: None, grant=())
    clock = Clock()
    svc = svc_factory(model, clock)
    before = metric("librarian_runs_total", mode="librarian", outcome="containment_failed")
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert metric("librarian_runs_total", mode="librarian", outcome="containment_failed") == before + 1


# --- misc -----------------------------------------------------------------


def test_refuses_live_mode(tmp_path):
    with pytest.raises(SystemExit):
        Service(make_settings(tmp_path, dry_run=False), index=make_index(tmp_path),
                runner=FakeModel(), prober=fake_prober)


def test_missing_prompt_skips_run(tmp_path, svc_factory, caplog):
    model = FakeModel()
    clock = Clock()
    svc = svc_factory(model, clock)
    os.unlink(os.path.join(svc.settings.prompts_dir, "reviewer.md"))
    add_libation(tmp_path)
    for dt in (0, 1, 11, 120):
        clock.t += dt
        svc.tick()
    assert model.calls == []
    assert "prompt" in caplog.text


def test_only_restricts_to_one_source_id(tmp_path, svc_factory):
    model = FakeModel()
    clock = Clock()
    svc = svc_factory(model, clock, only="B0SECOND00")
    add_libation(tmp_path)
    add_libation(tmp_path, asin="B0SECOND00", data=b"OTHER" * 50, title="Second")
    svc.tick()
    clock.t += 1
    svc.tick()
    assert [r["key"].split(":")[1] for r in svc.arrivals.all()] == ["B0SECOND00"]


def test_old_transcripts_are_pruned(tmp_path, svc_factory):
    svc = svc_factory(FakeModel())
    tdir = os.path.join(svc.settings.state_dir, "transcripts")
    os.makedirs(tdir, exist_ok=True)
    old = os.path.join(tdir, "old-librarian.jsonl")
    new = os.path.join(tdir, "new-librarian.jsonl")
    for p in (old, new):
        open(p, "w").close()
    t = time.time() - 31 * 86400
    os.utime(old, (t, t))
    svc.tick()
    assert not os.path.exists(old)
    assert os.path.exists(new)


def test_interrupted_run_is_recovered_on_startup(tmp_path, svc_factory):
    svc = svc_factory(FakeModel())
    # r0 completed (has a runs.jsonl record): its open escalation awaits a human
    with open(svc.runs_path, "a") as f:
        f.write(json.dumps({"run_id": "r0", "outcome": "ok"}) + "\n")
    svc.arrivals.record("libation:Z:abc", states.NEEDS_DECISION)
    svc.intents.store.record("r0:1", states.PROPOSED_I, run_id="r0", arrival="libation:Z:abc",
                             kind=states.ESCALATE, payload={})
    # r1 crashed mid-run (no record): all its open intents are partial effects
    svc.arrivals.record("libation:X:abc", states.PROPOSED)
    svc.arrivals.record("libation:Y:abc", states.NEEDS_DECISION)
    svc.arrivals.record("libation:W:abc", states.DEFERRED, not_before=10**12)
    svc.intents.store.record("r1:1", states.PROPOSED_I, run_id="r1", arrival="libation:X:abc",
                             kind=states.ATTACH, payload={})
    svc.intents.store.record("r1:2", states.PROPOSED_I, run_id="r1", arrival="libation:Y:abc",
                             kind=states.ESCALATE, payload={})
    svc.intents.store.record("r1:3", states.PROPOSED_I, run_id="r1", arrival="libation:W:abc",
                             kind=states.DEFER, payload={})
    svc.stop()
    svc2 = svc_factory(FakeModel())
    for k in ("X", "Y", "W"):
        assert svc2.arrivals.get(f"libation:{k}:abc")["state"] == states.READY, k
    for i in ("r1:1", "r1:2", "r1:3"):
        assert svc2.intents.store.get(i)["state"] == states.REJECTED, i
    assert svc2.intents.store.get("r0:1")["state"] == states.PROPOSED_I
    assert svc2.arrivals.get("libation:Z:abc")["state"] == states.NEEDS_DECISION


def test_deferred_arrival_is_reoffered_once_not_before_passes(tmp_path, svc_factory):
    def defer(call):
        _, arrivals = call("GET", "/arrivals")
        for a in arrivals:
            st, body = call("POST", "/intents", {"kind": "defer", "arrival": a["key"],
                                                 "not_before_hours": 2, "reason": "wait for epub"})
            assert st == 200, body

    model = FakeModel(librarian=defer)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    assert svc.arrivals.get(only_key(svc))["state"] == states.DEFERRED
    clock.t += 3600
    svc.tick()
    assert model.calls == ["librarian"]
    clock.t += 3600 + 1          # not_before passed -> a change; debounce still applies
    svc.tick()
    assert model.calls == ["librarian"]
    clock.t += 11
    svc.tick()
    assert model.calls == ["librarian", "librarian"]


# --- fix round 1 ---------------------------------------------------------------


def test_librarian_prompt_carries_count_not_keys(tmp_path, svc_factory):
    seen = []

    class Capture(FakeModel):
        def __call__(self, argv, **kw):
            seen.append(argv[argv.index("-p") + 1])
            return super().__call__(argv, **kw)

    model = Capture(librarian=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    assert len(seen) == 1
    prompt = seen[0]
    assert key not in prompt
    assert ASIN not in prompt and "Artificial Condition" not in prompt
    assert "1 arrival(s)" in prompt


def test_exception_inside_cycle_holds_arrivals_for_retry_after(tmp_path, svc_factory):
    model = FakeModel(librarian=attach_script(), reviewer=approve_all)
    clock = Clock()
    svc = svc_factory(model, clock)

    def boom(*a, **kw):
        raise RuntimeError("finalize exploded")

    svc.intents.finalize_dry_run = boom
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()                                   # must not propagate
    assert model.calls == ["librarian", "reviewer"]
    for _ in range(5):                               # the run's own writes are not "changes"
        clock.t += 120
        svc.tick()
    assert model.calls == ["librarian", "reviewer"]


def test_sigterm_during_reviewer_discards_whole_cycle(tmp_path, svc_factory):
    def reviewer(call):
        raise Stopping()                              # what main.py's handler raises

    model = FakeModel(librarian=attach_script(), reviewer=reviewer)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    svc.tick()
    clock.t += 1
    svc.tick()
    clock.t += 11
    with pytest.raises(Stopping):
        svc.tick()
    assert svc.current_run() is None
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.READY
    intents = svc.intents.store.all()
    assert [r["state"] for r in intents] == [states.REJECTED]      # no false escalation
    assert intents[0]["review"]["argument"] != "reviewer did not rule"
    with open(svc.runs_path) as f:
        assert json.loads(f.readlines()[-1])["outcome"] == "stopped"


def test_sigterm_during_librarian_discards_cycle(tmp_path, svc_factory):
    def librarian(call):
        attach_script()(call)
        raise Stopping()

    model = FakeModel(librarian=librarian)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    svc.tick()
    clock.t += 1
    svc.tick()
    clock.t += 11
    with pytest.raises(Stopping):
        svc.tick()
    assert model.calls == ["librarian"]
    assert svc.arrivals.get(only_key(svc))["state"] == states.READY
    assert [r["state"] for r in svc.intents.store.all()] == [states.REJECTED]


def test_stopping_is_not_an_exception():
    assert not issubclass(Stopping, Exception)


def test_non_offerable_marks_are_pruned(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(), clock)
    data = b"AUDIO" * 100
    sha = hashlib.sha256(data).hexdigest()
    svc.arrivals.record(f"libation:B0OLDCOPY0:{sha[:12]}", states.FILED, sha256=sha, book_id=2)
    add_libation(tmp_path, asin="B0NEWCOPY0", data=data)
    for dt in (0, 1, 1):
        clock.t += dt
        svc.tick()
    assert svc._changed == {}


def test_invalid_kids_lists_logged_once(tmp_path, svc_factory, caplog):
    svc = svc_factory(FakeModel())
    os.makedirs(svc.settings.lists_dir, exist_ok=True)
    with open(os.path.join(svc.settings.lists_dir, "kids-allowlist.json"), "w") as f:
        f.write("{not json")
    caplog.set_level(logging.ERROR)
    for _ in range(3):
        svc.tick()
    assert sum("kids lists invalid" in r.getMessage() for r in caplog.records) == 1


# --- final review I1: reviewer trailer counts filings only ------------------------


def test_reviewer_trailer_counts_filings_only(tmp_path, svc_factory):
    prompts = []

    def librarian(call):
        _, arrivals = call("GET", "/arrivals")
        keys = sorted(a["key"] for a in arrivals)
        call("GET", f"/arrivals/{q(keys[0])}")
        st, body = call("POST", "/intents", {"kind": "attach", "arrival": keys[0], "book_id": 2,
                                             "reason": "same audible asin"})
        assert st == 200 and body["status"] == states.PROPOSED_I, body
        st, body = call("POST", "/intents", {"kind": "escalate", "arrival": keys[1], "question": "which?",
                                             "options": [{"label": "a"}, {"label": "b"}],
                                             "recommendation": "a"})
        assert st == 200 and body["status"] == states.PROPOSED_I, body

    def reviewer(call):
        st, props = call("GET", "/proposals")
        assert [p["kind"] for p in props] == ["attach"]

    class Capture(FakeModel):
        def __call__(self, argv, **kw):
            prompts.append(argv[argv.index("-p") + 1])
            return super().__call__(argv, **kw)

    model = Capture(librarian=librarian, reviewer=reviewer)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    add_libation(tmp_path, asin="B0SECOND00", data=b"OTHER" * 50, title="Second")
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian", "reviewer"]
    assert "1 proposal(s)" in prompts[1]


def test_escalation_only_run_launches_no_reviewer(tmp_path, svc_factory):
    def librarian(call):
        _, arrivals = call("GET", "/arrivals")
        for a in arrivals:
            st, body = call("POST", "/intents", {"kind": "escalate", "arrival": a["key"], "question": "?",
                                                 "options": [{"label": "a"}, {"label": "b"}],
                                                 "recommendation": "a"})
            assert st == 200, body

    model = FakeModel(librarian=librarian)
    clock = Clock()
    svc = svc_factory(model, clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    assert svc.arrivals.get(only_key(svc))["state"] == states.NEEDS_DECISION


# --- final review I2: runs.jsonl torn-tail repair; finalized intents are terminal ---


def _run_records(svc):
    from app.store import read_records
    return [r for r in read_records(svc.runs_path) if r.get("event") != "start"]


def _escalate_script(call):
    _, arrivals = call("GET", "/arrivals")
    for a in arrivals:
        st, body = call("POST", "/intents", {"kind": "escalate", "arrival": a["key"], "question": "which?",
                                             "options": [{"label": "a"}, {"label": "b"}],
                                             "recommendation": "a"})
        assert st == 200, body


def test_torn_runs_tail_is_repaired_before_next_append(tmp_path, svc_factory):
    model = FakeModel(librarian=lambda call: None)
    clock = Clock()
    svc = svc_factory(model, clock)
    os.makedirs(os.path.dirname(svc.runs_path), exist_ok=True)
    with open(svc.runs_path, "w") as f:
        f.write('{"run_id": "old", "outc')                  # a torn final write
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    assert model.calls == ["librarian"]
    recs = _run_records(svc)                                 # parses: nothing glued on
    assert [r["outcome"] for r in recs] == ["ok"]


def test_completed_run_with_torn_record_is_not_treated_as_interrupted(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(librarian=_escalate_script), clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    assert svc.arrivals.get(key)["state"] == states.NEEDS_DECISION
    esc = [r for r in svc.intents.store.all() if r["kind"] == states.ESCALATE]
    assert [r["state"] for r in esc] == [states.SIMULATED_I]
    svc.stop()
    # the end record's write was torn by a crash
    with open(svc.runs_path, "rb") as f:
        data = f.read()
    with open(svc.runs_path, "wb") as f:
        f.write(data[:-20])

    model2 = FakeModel(librarian=_escalate_script)
    svc2 = svc_factory(model2, clock)
    assert svc2.arrivals.get(key)["state"] == states.NEEDS_DECISION
    assert svc2.intents.store.get(esc[0]["intent_id"])["state"] == states.SIMULATED_I
    for _ in range(3):
        clock.t += 4000
        svc2.tick()
    assert model2.calls == []


# --- final review I3: restart does not re-offer already-offered arrivals ----------


def test_restart_does_not_reoffer_arrival_the_last_run_left_alone(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(librarian=lambda call: None), clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    svc.stop()

    model2 = FakeModel(librarian=lambda call: None)
    svc2 = svc_factory(model2, clock)
    for _ in range(5):
        clock.t += 4000
        svc2.tick()
    assert model2.calls == []
    assert svc2.arrivals.get(only_key(svc2))["state"] == states.READY


def test_restart_still_offers_never_offered_arrival(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(), clock)
    add_libation(tmp_path)
    svc.tick()
    clock.t += 1
    svc.tick()                          # READY, debounce not yet elapsed
    svc.stop()

    model2 = FakeModel(librarian=lambda call: None)
    svc2 = svc_factory(model2, clock)
    clock.t += 1
    svc2.tick()
    clock.t += 11
    svc2.tick()
    assert model2.calls == ["librarian"]


def test_restart_offers_arrival_answered_after_the_run(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(librarian=lambda call: None), clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    key = only_key(svc)
    svc.stop()
    time.sleep(0.01)
    svc.arrivals.record(key, states.ANSWERED, human_answer="it's book 2")

    model2 = FakeModel(librarian=lambda call: None)
    svc2 = svc_factory(model2, clock)
    clock.t += 1
    svc2.tick()
    clock.t += 11
    svc2.tick()
    assert model2.calls == ["librarian"]


def test_restart_after_interrupted_run_holds_arrivals_for_retry_after(tmp_path, svc_factory):
    def crash(call):
        attach_script()(call)
        raise KeyboardInterrupt()          # stands in for SIGKILL/OOM: no end record

    clock = Clock()
    svc = svc_factory(FakeModel(librarian=crash), clock)
    add_libation(tmp_path)
    svc.tick()
    clock.t += 1
    svc.tick()
    clock.t += 11
    with pytest.raises(KeyboardInterrupt):
        svc.tick()
    svc.stop()

    model2 = FakeModel(librarian=lambda call: None)
    svc2 = svc_factory(model2, clock)
    key = only_key(svc2)
    assert svc2.arrivals.get(key)["state"] == states.READY           # recovered
    for _ in range(5):
        clock.t += 600
        svc2.tick()
    assert model2.calls == []                                        # held: 3000s < retry_after
    clock.t += 700
    svc2.tick()
    assert model2.calls == ["librarian"]


def test_restart_after_failed_run_keeps_holding_until_retry_after(tmp_path, svc_factory):
    clock = Clock()
    svc = svc_factory(FakeModel(librarian=lambda call: None, timed_out=True), clock)
    add_libation(tmp_path)
    for dt in (0, 1, 11):
        clock.t += dt
        svc.tick()
    ended = clock.t
    svc.stop()

    model2 = FakeModel(librarian=lambda call: None)
    svc2 = svc_factory(model2, clock)
    clock.t += 60
    svc2.tick()
    clock.t += 60
    svc2.tick()
    assert model2.calls == []
    clock.t = ended + 3600 + 11          # released at retry_after; debounce still applies
    svc2.tick()
    assert model2.calls == ["librarian"]
