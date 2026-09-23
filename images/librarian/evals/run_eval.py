"""Librarian eval harness: the REAL service tick, the REAL sandboxed `claude -p`,
a fake BookOrbit.

Each case in evals/cases/*.json builds a throwaway intake + state tree, serves
its `library` through a fake BookOrbit transport, and runs `Service.tick()`
(QUIET_PERIOD=0, DEBOUNCE=0, injected clock) with the production runner until
the cycle's run record exists. The graded outcome is the POST-REVIEW result
for the case's single arrival:

  arrival SIMULATED       -> the approved attach/create_book intent
  arrival NEEDS_DECISION  -> "escalate" (incl. a reviewer rejection)
  arrival DEFERRED        -> "defer"
  anything else           -> "none" (always a FAIL)

Usage (from images/librarian, CLAUDE_CODE_OAUTH_TOKEN exported):

    uv run -q --with requests --with "mcp<2" --with pytest python evals/run_eval.py \
        --prompts <dir with librarian.md + reviewer.md> --model opus [--case NAME ...]

Transcripts, dossiers and the intent ledger of every case are copied to
--out (default /tmp/librarian-evals/<timestamp>/<case>/) for analysis.

Case file schema (see evals/README.md):
  {"name", "arrival": {source, source_id, folder?, files: [{name, kind, size,
   probe|epub}], sidecar?}, "library": [BookOrbit detail dicts], "kids_lists"?:
   {"allow": {...}, "deny": {...}}, "expect": {"kind_in": [...], "book_id"?,
   "library"?, "title_contains"?, "readalong"?, "forbid"?: {"book_id"?, "library"?}}}
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_DIR = os.path.dirname(HERE)
sys.path.insert(0, IMAGE_DIR)

from app import runs, states  # noqa: E402
from app.bookorbit import BookorbitClient, LibraryIndex  # noqa: E402
from app.config import Settings  # noqa: E402
from app.service import Service  # noqa: E402
from tests.fixtures import make_epub  # noqa: E402

LIBRARY_NAMES = {"Library": 7, "Kids Audiobooks": 8, "Comics": 3}
LOREM = ("It was a bright cold day in April, and the clocks were striking thirteen. "
         "The ship drifted on, silent, while the crew slept and the engines hummed. ")


# --- fake BookOrbit ---------------------------------------------------------------


def _names(v):
    out = []
    for i, n in enumerate(v or []):
        if isinstance(n, dict):
            out.append(n)
        else:
            last = n.split()[-1] if n.split() else n
            out.append({"id": 1000 + i, "name": n, "sortName": last})
    return out


def normalize_book(b: dict, local_root: str) -> dict:
    """Fill a case's compact BookOrbit detail into the real GET /books/{id}
    shape; real EPUBs are written for files carrying `text_chars`."""
    d = dict(b)
    d.setdefault("subtitle", None)
    d["authors"] = _names(d.get("authors"))
    d.setdefault("providerIds", {})
    d.setdefault("tags", [])
    d.setdefault("isbn13", None)
    d.setdefault("isbn10", None)
    d.setdefault("libraryName", "Library")
    d.setdefault("seriesName", None)
    d.setdefault("seriesIndex", None)
    d.setdefault("publishedYear", None)
    d.setdefault("readAloudSync", {"state": "unavailable"})
    d.setdefault("updatedAt", f"u{d['id']}")
    narrators = d.pop("narrators", None)
    if narrators:
        d["audioMetadata"] = {"narrators": _names(narrators)}
    first = d["authors"][0]["name"] if d["authors"] else "Unknown"
    d.setdefault("folderPath", f"/books/{d['libraryName']}/{first}/{d['title']}")
    files = []
    for f in d.get("files") or []:
        f = dict(f)
        text_chars = f.pop("text_chars", None)
        f.setdefault("absolutePath", f"{d['folderPath']}/{f['filename']}")
        if text_chars and f.get("format") == "epub":
            local = local_root + f["absolutePath"][len("/books"):]
            os.makedirs(os.path.dirname(local), exist_ok=True)
            make_epub(local, d["title"], [a["name"] for a in d["authors"]], _text(text_chars))
        files.append(f)
    d["files"] = files
    return d


def fake_transport(books: dict):
    def t(method, url, body, headers):
        if url.endswith("/auth/login") or url.endswith("/auth/refresh"):
            return 200, json.dumps({"accessToken": "tok"})
        if url.endswith("/books/query"):
            page = json.loads(body)["pagination"]["page"]
            items = [{"id": i, "updatedAt": b["updatedAt"]} for i, b in books.items()] if page == 0 else []
            return 200, json.dumps({"items": items, "total": len(books), "page": page, "size": 100})
        m = re.search(r"/books/(\d+)$", url)
        if m and int(m.group(1)) in books:
            return 200, json.dumps(books[int(m.group(1))])
        return 404, json.dumps({"error": "not found"})
    return t


# --- intake -------------------------------------------------------------------------


def _text(n: int) -> str:
    return (LOREM * (n // len(LOREM) + 1))[:n]


def build_arrival(case: dict, intake_root: str) -> dict:
    """Write the arrival's files; returns {basename: probe} for the fake prober."""
    a = case["arrival"]
    src = a["source"]
    probes = {}
    base = os.path.join(intake_root, src)
    os.makedirs(os.path.join(intake_root, "libation"), exist_ok=True)
    os.makedirs(os.path.join(intake_root, "kindle"), exist_ok=True)
    os.makedirs(os.path.join(intake_root, "manual"), exist_ok=True)
    if src == "kindle":
        folder = base
    else:
        folder = os.path.join(base, a.get("folder") or f"{a.get('title', 'Untitled')} [{a['source_id']}]")
    os.makedirs(folder, exist_ok=True)
    for f in a["files"]:
        path = os.path.join(folder, f["name"])
        if f["kind"] == "epub":
            e = f["epub"]
            make_epub(path, e["title"], e.get("creators", []), _text(e.get("chars", 2000)),
                      date=e.get("date", "2020"), identifiers=e.get("identifiers"),
                      description=e.get("description"))
        else:
            with open(path, "wb") as fh:
                # distinct bytes per file so keys/hashes differ between cases
                seed = hashlib.sha256((case["name"] + f["name"]).encode()).digest()
                fh.write((seed * (f.get("size", 4096) // len(seed) + 1))[: f.get("size", 4096)])
            if "probe" in f:
                probes[f["name"]] = f["probe"]
    if src == "kindle":
        epub = next(f for f in a["files"] if f["kind"] in ("epub", "cbz"))
        path = os.path.join(folder, epub["name"])
        with open(path, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        sidecar = dict(a.get("sidecar") or {})
        sidecar.setdefault("asin", a["source_id"])
        sidecar.setdefault("source", "kindle")
        sidecar.setdefault("kind", "ebook")
        sidecar["sha256"] = sha
        stem = os.path.splitext(epub["name"])[0]
        with open(os.path.join(folder, f"{stem}.json"), "w") as fh:
            json.dump(sidecar, fh)
    return probes


def make_prober(probes: dict):
    def prober(path):
        name = os.path.basename(path)
        if name not in probes:
            raise RuntimeError(f"no probe for {name}")
        p = probes[name]
        return {"format": {"duration": str(p.get("duration", "")), "tags": p.get("tags", {})},
                "chapters": [{"tags": {"title": t}} for t in p.get("chapters", [])]
                + [{"tags": {}} for _ in range(max(0, p.get("chapter_count", 0) - len(p.get("chapters", []))))]}
    return prober


# --- grading -------------------------------------------------------------------------


class Clock:
    def __init__(self, t=100_000.0):
        self.t = t

    def __call__(self):
        return self.t


def _fold(s) -> str:
    return re.sub(r"[^0-9a-z]", "", str(s or "").casefold())


def outcome(svc, key: str) -> dict:
    rec = svc.arrivals.get(key) or {}
    st = rec.get("state")
    intents = [r for r in svc.intents.store.all() if r.get("arrival") == key]
    got = {"state": st, "kind": "none"}
    if st == states.SIMULATED:
        sim = next((r for r in intents if r.get("state") == states.SIMULATED_I), None)
        if sim:
            p = sim.get("payload") or {}
            got.update(kind=sim["kind"], book_id=p.get("book_id"), library=p.get("library"),
                       title=(p.get("metadata") or {}).get("title"), readalong=p.get("readalong", True),
                       metadata=p.get("metadata"))
            if sim["kind"] == states.ATTACH:
                book = svc.index.book(p.get("book_id")) or {}
                got["library"] = {"Library": "adult", "Kids Audiobooks": "kids"}.get(book.get("libraryName"),
                                                                                    book.get("libraryName"))
    elif st == states.NEEDS_DECISION:
        got["kind"] = "escalate"
    elif st == states.DEFERRED:
        got["kind"] = "defer"
    got["trail"] = [
        {"kind": r.get("kind"), "state": r.get("state"),
         "book_id": (r.get("payload") or {}).get("book_id"),
         "library": (r.get("payload") or {}).get("library"),
         "title": ((r.get("payload") or {}).get("metadata") or {}).get("title"),
         "reason": r.get("reason"), "guard": r.get("guard"),
         "review": r.get("review"),
         "question": (r.get("payload") or {}).get("question")}
        for r in intents
    ]
    return got


def grade(expect: dict, got: dict) -> tuple[bool, str]:
    kind = got["kind"]
    if kind not in expect["kind_in"]:
        return False, f"kind {kind} not in {expect['kind_in']}"
    forbid = expect.get("forbid") or {}
    if "book_id" in forbid and got.get("book_id") == forbid["book_id"]:
        return False, f"forbidden book_id {forbid['book_id']}"
    if "library" in forbid and got.get("library") == forbid["library"]:
        return False, f"forbidden library {forbid['library']}"
    if kind == "attach" and "book_id" in expect and got.get("book_id") != expect["book_id"]:
        return False, f"attached to {got.get('book_id')}, expected {expect['book_id']}"
    if kind == "create_book":
        if "library" in expect and got.get("library") != expect["library"]:
            return False, f"library {got.get('library')}, expected {expect['library']}"
        if "title_contains" in expect and _fold(expect["title_contains"]) not in _fold(got.get("title")):
            return False, f"title {got.get('title')!r} lacks {expect['title_contains']!r}"
        if "readalong" in expect and got.get("readalong") != expect["readalong"]:
            return False, f"readalong {got.get('readalong')}, expected {expect['readalong']}"
    return True, "ok"


def expected_str(expect: dict) -> str:
    s = "|".join(expect["kind_in"])
    if "book_id" in expect:
        s += f" #{expect['book_id']}"
    if "library" in expect:
        s += f" {expect['library']}"
    if "title_contains" in expect:
        s += f" ~{expect['title_contains']!r}"
    if "readalong" in expect:
        s += f" ra={expect['readalong']}"
    if expect.get("forbid"):
        s += " !" + ",".join(f"{k}={v}" for k, v in expect["forbid"].items())
    return s


def got_str(got: dict) -> str:
    k = got["kind"]
    if k == "attach":
        return f"attach #{got.get('book_id')}"
    if k == "create_book":
        return f"create_book {got.get('library')} {got.get('title')!r} ra={got.get('readalong')}"
    return k


# --- one case ---------------------------------------------------------------------------


def run_case(case: dict, args, out_root: str) -> dict:
    tmp = tempfile.mkdtemp(prefix=f"libeval-{case['name']}-")
    try:
        intake_root = os.path.join(tmp, "intake")
        local_root = os.path.join(tmp, "media", "books")
        lists_dir = os.path.join(tmp, "lists")
        os.makedirs(lists_dir)
        kl = case.get("kids_lists") or {}
        for which in ("allow", "deny"):
            with open(os.path.join(lists_dir, f"kids-{which}list.json"), "w") as f:
                json.dump(kl.get(which, {}), f)

        books = {b["id"]: normalize_book(b, local_root) for b in case.get("library", [])}
        probes = build_arrival(case, intake_root)

        settings = Settings(
            bookorbit_url="http://bookorbit.invalid/api/v1", bookorbit_user="u", bookorbit_pass="p",
            intake_root=intake_root, local_books_root=local_root,
            state_dir=os.path.join(tmp, "state"), lists_dir=lists_dir,
            prompts_dir=args.prompts, quiet_period=0, debounce=0, api_port=0,
            runs_root=os.path.join(tmp, "runs"), model=args.model, reviewer_model=args.model,
            claude_bin=args.claude_bin, run_timeout=args.timeout, retry_after=3600,
        )
        client = BookorbitClient(settings.bookorbit_url, "u", "p", transport=fake_transport(books),
                                 cookie_path=os.path.join(tmp, "cookies.txt"))
        client.authenticate()
        index = LibraryIndex(client, state_path=os.path.join(tmp, "idx.json"), local_root=local_root)
        index.refresh(now=0, force=True)

        clock = Clock()
        svc = Service(settings, index=index, prober=make_prober(probes), clock=clock)
        started = time.time()
        try:
            for _ in range(6):
                clock.t += 1
                svc.tick()
                if os.path.exists(svc.runs_path):
                    break
            recs = svc.arrivals.all()
            record = {}
            if os.path.exists(svc.runs_path):
                with open(svc.runs_path) as f:
                    record = json.loads(f.readlines()[-1])
            if len(recs) != 1:
                got = {"kind": "none", "error": f"{len(recs)} arrivals recorded", "trail": []}
            else:
                got = outcome(svc, recs[0]["key"])
        finally:
            svc.stop()

        cost = 0.0
        for phase in ("librarian", "reviewer"):
            c = (record.get(phase) or {}).get("cost_usd")
            if isinstance(c, (int, float)):
                cost += c
        ok, why = grade(case["expect"], got)
        if record.get("outcome") not in (None, "ok"):
            why += f" (run outcome {record.get('outcome')})"

        dest = os.path.join(out_root, case["name"])
        os.makedirs(dest, exist_ok=True)
        for p in glob.glob(os.path.join(settings.state_dir, "transcripts", "*")):
            shutil.copy(p, dest)
        for p in glob.glob(os.path.join(settings.state_dir, "dossiers", "*.json")):
            shutil.copy(p, os.path.join(dest, "dossier.json"))
        for name in ("intents.jsonl", "arrivals.jsonl", "runs.jsonl"):
            p = os.path.join(settings.state_dir, name)
            if os.path.exists(p):
                shutil.copy(p, dest)
        result = {"name": case["name"], "expected": expected_str(case["expect"]), "got": got_str(got),
                  "pass": ok, "why": why, "cost": round(cost, 4), "seconds": round(time.time() - started),
                  "run": record, "detail": got}
        with open(os.path.join(dest, "result.json"), "w") as f:
            json.dump(result, f, indent=2)
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _patch_shim_pythonpath():
    """In the image the shim is importable from /app; here it is IMAGE_DIR."""
    orig = runs.build_mcp_config

    def build(python, api, token, mode):
        cfg = orig(python, api, token, mode)
        cfg["mcpServers"]["librarian"]["env"]["PYTHONPATH"] = IMAGE_DIR
        return cfg
    runs.build_mcp_config = build


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--prompts", required=True, help="dir holding librarian.md and reviewer.md")
    ap.add_argument("--model", default="opus")
    ap.add_argument("--case", action="append", help="run only these case names (repeatable)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=int, default=900, help="per claude run, seconds")
    ap.add_argument("--budget", type=float, default=60.0, help="stop once cumulative cost exceeds this")
    ap.add_argument("--claude-bin", default=shutil.which("claude") or "claude")
    args = ap.parse_args(argv)

    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        print("CLAUDE_CODE_OAUTH_TOKEN is not set", file=sys.stderr)
        return 2
    for name in ("librarian.md", "reviewer.md"):
        if not os.path.isfile(os.path.join(args.prompts, name)):
            print(f"missing {name} in {args.prompts}", file=sys.stderr)
            return 2
    _patch_shim_pythonpath()

    cases = []
    for p in sorted(glob.glob(os.path.join(HERE, "cases", "*.json"))):
        with open(p) as f:
            c = json.load(f)
        if args.case and c["name"] not in args.case:
            continue
        cases.append(c)
    out_root = args.out or os.path.join("/tmp/librarian-evals", time.strftime("%Y%m%dT%H%M%S"))
    os.makedirs(out_root, exist_ok=True)

    results = []
    total = 0.0
    for c in cases:
        if total > args.budget:
            print(f"budget ${args.budget:.2f} exceeded (${total:.2f}); skipping {c['name']}", flush=True)
            results.append({"name": c["name"], "expected": expected_str(c["expect"]), "got": "skipped",
                            "pass": False, "why": "budget", "cost": 0.0})
            continue
        r = run_case(c, args, out_root)
        total += r["cost"]
        results.append(r)
        print(f"{r['name']:32} {'PASS' if r['pass'] else 'FAIL'}  ${r['cost']:.2f}  {r['got']}  ({r['why']})",
              flush=True)

    print()
    print("| case | expected | got | result | cost |")
    print("|---|---|---|---|---|")
    for r in results:
        print(f"| {r['name']} | {r['expected']} | {r['got']} | {'PASS' if r['pass'] else 'FAIL'} "
              f"| ${r['cost']:.2f} |")
    n = sum(1 for r in results if r["pass"])
    print(f"\n{n}/{len(results)} PASS, total cost ${total:.2f}; artifacts in {out_root}")
    with open(os.path.join(out_root, "summary.json"), "w") as f:
        json.dump({"results": results, "total_cost": total, "passed": n}, f, indent=2, default=str)
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
