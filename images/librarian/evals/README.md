# Librarian evals

Cases (spec §7, plus Plan 2's update_metadata and answered-escalation cases) that run the **real** service cycle — intake scan, dossier,
librarian `claude -p` run, reviewer `claude -p` run, dry-run finalize — against a fake
BookOrbit, using the production runner and lockdown argv. They grade the prompts, which
live outside this repo (the deployment's `prompts/librarian.md` and `prompts/reviewer.md`).

```bash
cd images/librarian
bao login -method=kubernetes role=toolbox jwt=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token) >/dev/null
export CLAUDE_CODE_OAUTH_TOKEN=$(bao kv get -field=CLAUDE_CODE_OAUTH_TOKEN secret/apps/toolbox/claude-scheduler)
uv run -q --with requests --with prometheus-client==0.26.0 --with "mcp<2" --with pytest \
  python evals/run_eval.py --prompts <prompts dir> --model opus [--case NAME ...]
```

Cases run sequentially (one librarian + at most one reviewer run each, roughly
$0.5–2 per case on opus). `--budget` (default $60) stops the set once cumulative cost
exceeds it. Artifacts — transcripts, the dossier, the intent/arrival ledgers and
`result.json` per case, `summary.json` overall — go to `--out`
(default `/tmp/librarian-evals/<timestamp>/`).

## Grading

The graded outcome is the arrival's state **after review**:

| arrival state | graded as |
|---|---|
| `simulated` | the approved `attach` / `create_book` intent |
| `needs-decision` | `escalate` (a reviewer rejection lands here too) |
| `deferred` | `defer` |
| anything else | `none` — always a FAIL |

A run whose librarian or reviewer phase did not end `ok` (crash, timeout, containment)
is a FAIL, as is an escalation produced by "reviewer did not rule". The `got` column
shows the escalation origin (`escalate[librarian]`, `escalate[reviewer]`) and the
reviewer's verdicts; the `guard-rejects` column lists intents the guards refused.

`expect.kind_in` must contain the graded kind. `book_id` is checked for `attach`;
`library`, `title_contains` (case/punctuation-insensitive) and `readalong` for
`create_book`; `forbid.book_id` (an id or a list) / `forbid.library` apply to the outcome AND to every
intent the model submitted, including guard-rejected ones — trying a forbidden target is a
FAIL even if a guard stopped it (an attach's library is the target book's).
`expect.escalate_origin: "reviewer"` (or `"librarian"`) requires the escalation to come
from a reviewer rejection (or from the librarian itself).
`expect.update_metadata` grades the arrival's `update_metadata` intent: `state`
(`simulated` = approved, `rejected`, or `absent`), `fields` (each must be in the patch with
that value), `forbid_keys` (fields the patch must not touch) and `lock_max` (the lock list
must be a subset).

**Answered escalations** carry `answered: {"escalation": {question, options,
recommendation}, "reply": "..."}`. When the arrival is ingested the harness records that
escalation as a finalized earlier one (options' intents get the arrival key), moves the
arrival to `needs-decision` and then to `answered` with the `human_answer` that the real
Vikunja reply parser (`app.escalations.parse_answer`) builds from `reply` — so `"2"` selects
option 2 and its intent, free text selects nothing. The run then sees it exactly as after a
real reply.

**Reviewer cases** (`rev-*`) carry a `scripted_intent` (or a list, `scripted_intents`,
e.g. an attach and its update_metadata): the librarian phase is replaced by a scripted
runner that submits exactly those intents through the internal API with the run token
(calling `get_book` first so guard 1 accepts an attach); the reviewer phase is the real
`claude -p`. Most expect `escalate` by `reviewer`; a case whose attach is sound but whose
update_metadata is not expects the attach plus `update_metadata.state: "rejected"`. The filing cases are the
controls: the same reviewer must still approve them. Change the prompts to fix a failure, never the expectations.

## Case format

```json
{
  "name": "…",
  "note": "what the case is about",
  "arrival": {
    "source": "libation|kindle|manual",
    "source_id": "B0…",
    "folder": "Title [B0…]",             // libation/manual folder name
    "sidecar": {"title": "…", "authors": ["…"]},   // kindle; sha256/asin filled in
    "files": [
      {"name": "x.m4b", "kind": "m4b", "size": 8000,
       "probe": {"duration": 40260, "tags": {…}, "chapters": ["…"], "chapter_count": 29}},
      {"name": "x.epub", "kind": "epub",
       "epub": {"title": "…", "creators": ["…"], "chars": 250000, "date": "2017",
                "description": "…"}}
    ]
  },
  "library": [ {BookOrbit GET /books/{id} detail; authors/narrators may be plain strings,
                missing fields are defaulted; every epub file gets a real EPUB
                (`text_chars` sets its length, default 3000) so search_in_book works} ],
  "kids_lists": {"allow": {"series": [], "asins": [], "authors": [{"name": "…", "whole_author": false}]},
                 "deny": {…}},
  "expect": {"kind_in": ["attach"], "book_id": 307, "forbid": {"book_id": 308}}
}
```

m4b files are placeholder bytes (`size` decides which is primary); a fake prober returns
each file's `probe`. EPUBs are real, built with `tests.fixtures.make_epub`.
