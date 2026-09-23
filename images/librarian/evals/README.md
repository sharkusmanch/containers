# Librarian evals

Twelve cases (spec §7) that run the **real** service cycle — intake scan, dossier,
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

`expect.kind_in` must contain the graded kind. `book_id` is checked for `attach`;
`library`, `title_contains` (case/punctuation-insensitive) and `readalong` for
`create_book`; `forbid.book_id` / `forbid.library` always apply (an attach's library is
the target book's). Change the prompts to fix a failure, never the expectations.

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
                missing fields are defaulted; a file with "text_chars" gets a real EPUB
                so search_in_book works} ],
  "kids_lists": {"allow": {"series": [], "asins": [], "authors": [{"name": "…", "whole_author": false}]},
                 "deny": {…}},
  "expect": {"kind_in": ["attach"], "book_id": 307, "forbid": {"book_id": 308}}
}
```

m4b files are placeholder bytes (`size` decides which is primary); a fake prober returns
each file's `probe`. EPUBs are real, built with `tests.fixtures.make_epub`.
