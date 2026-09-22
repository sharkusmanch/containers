"""Kids allow/deny lists, folder-name rendering, and submission guards.

`check_intent` is the hard boundary between an LLM's proposed intent and any
action the service will actually take: every field it reasons about --
`ctx.dossier` (trusted-only sections), `ctx.index` (real BookOrbit state),
`ctx.run_claims` (this run's already-accepted intents), `ctx.lists` (the
GitOps-reviewed kids allow/denylists) -- is data this module trusts, never
the intent itself beyond its declared shape. `validate_shape` runs first and
rejects anything that doesn't match the wire contract (including the
`update_metadata` kind, which is out of scope for this plan); `check_intent`
then walks the numbered guards from spec section 3.4 that are in scope for
this plan (1, 4, 5, 6, 7, 8, 10 -- guards 2/3/9 are execution-time checks
that ship with the Plan 2 executor).

Recording claims into `ctx.run_claims` is NOT this module's job (see
`claims_for`) -- `check_intent` only reads `run_claims`, it never mutates it.
The caller (the intent submission path, Task 8) is responsible for calling
`claims_for` on an accepted intent and writing the returned keys into the
run's claim table under `core.lock`.
"""
import json
import os
from dataclasses import dataclass, field

from app.states import ATTACH, CREATE_BOOK, DEFER, ESCALATE, INTENT_KINDS
from app.titles import normalize

GuardResult = tuple[bool, str]

# adult/kids are the only intent-facing library names; "Comics" (BookOrbit id
# 3) is never a filing target per the plan's global constraints.
_LIBRARY_NAMES = {"adult": "Library", "kids": "Kids Audiobooks"}
_KIDS_LIBRARY_NAME = "Kids Audiobooks"

_MAX_STRING_LEN = 2000


# --- KidsLists / kids_signals ------------------------------------------------


@dataclass
class _KidsList:
    series: set = field(default_factory=set)
    asins: set = field(default_factory=set)
    # (normalized name, whole_author) pairs
    authors: list = field(default_factory=list)


def _norm_asin(a) -> str:
    return str(a).strip().casefold()


def _load_kids_list(lists_dir, filename) -> _KidsList:
    path = os.path.join(str(lists_dir), filename)
    try:
        with open(path) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}

    series = {normalize(s) for s in data.get("series", []) if normalize(s)}
    asins = {_norm_asin(a) for a in data.get("asins", []) if a}
    authors = [
        (normalize(a.get("name", "")), bool(a.get("whole_author", False)))
        for a in data.get("authors", [])
        if normalize(a.get("name", ""))
    ]
    return _KidsList(series=series, asins=asins, authors=authors)


@dataclass
class KidsLists:
    allow: _KidsList
    deny: _KidsList

    @classmethod
    def load(cls, lists_dir) -> "KidsLists":
        return cls(
            allow=_load_kids_list(lists_dir, "kids-allowlist.json"),
            deny=_load_kids_list(lists_dir, "kids-denylist.json"),
        )


def kids_signals(lists: KidsLists, *, series=None, asins=(), authors=()) -> dict:
    """Normalized allow/deny signals for the given arrival attributes.

    An author entry on the allowlist counts only when `whole_author` is
    true (a partial-catalog allow entry is not enough to file into Kids);
    a denylist author entry counts regardless of that flag -- caution wins
    on the deny side. Series/asin entries always count on both lists.
    """
    norm_series = normalize(series) if series else ""
    norm_asins = {_norm_asin(a) for a in asins if a}
    norm_authors = {normalize(a) for a in authors if normalize(a)}

    def _match(klist: _KidsList, *, whole_author_only: bool) -> list:
        hits = []
        if norm_series and norm_series in klist.series:
            hits.append(f"series:{norm_series}")
        for a in sorted(norm_asins & klist.asins):
            hits.append(f"asin:{a}")
        for name, whole_author in klist.authors:
            if whole_author_only and not whole_author:
                continue
            if name in norm_authors:
                hits.append(f"author:{name}")
        return hits

    return {
        "allow": _match(lists.allow, whole_author_only=True),
        "deny": _match(lists.deny, whole_author_only=False),
    }


# --- render_folder -----------------------------------------------------------


def _format_index(idx) -> str:
    f = float(idx)
    if f.is_integer():
        return str(int(f))
    return f"{f:g}"


def render_folder(first_author: str, series: str | None, series_index, title: str) -> str:
    """BookOrbit's `{authors:first}/<{series}/><{seriesIndex}. >{title}`.

    A missing series drops both the `series/` path segment AND the
    `N. ` title prefix (the prefix is only meaningful alongside a series);
    a present series with no index drops only the prefix.
    """
    parts = [first_author]
    if series:
        parts.append(series)
        if series_index is not None:
            title = f"{_format_index(series_index)}. {title}"
    parts.append(title)
    return "/".join(parts)


def _folder_tail(folder_path, library_name):
    if not folder_path:
        return None
    prefix = f"/books/{library_name}/"
    if folder_path.startswith(prefix):
        return folder_path[len(prefix):]
    return folder_path


# --- shape validation --------------------------------------------------------

_OPTION_FIELDS = {"required": {"label"}, "optional": {"intent"}}
_METADATA_FIELDS = {
    "required": {"title", "authors"},
    "optional": {
        "subtitle", "series", "seriesIndex", "publishedYear", "language",
        "audibleId", "asinTag", "narrators",
    },
}
_KIND_FIELDS = {
    ATTACH: {"required": {"arrival", "book_id", "reason"}, "optional": {"readalong"}},
    CREATE_BOOK: {"required": {"arrival", "library", "metadata", "reason"}, "optional": {"readalong"}},
    ESCALATE: {"required": {"arrival", "question", "options", "recommendation"}, "optional": set()},
    DEFER: {"required": {"arrival", "reason", "not_before_hours"}, "optional": set()},
}


def _oversized_string_path(node, path="intent"):
    if isinstance(node, str):
        return path if len(node) > _MAX_STRING_LEN else None
    if isinstance(node, dict):
        for k, v in node.items():
            hit = _oversized_string_path(v, f"{path}.{k}")
            if hit:
                return hit
    elif isinstance(node, list):
        for i, v in enumerate(node):
            hit = _oversized_string_path(v, f"{path}[{i}]")
            if hit:
                return hit
    return None


def _fields_check(obj, spec, *, label) -> str | None:
    allowed = spec["required"] | spec["optional"]
    unknown = set(obj) - allowed
    if unknown:
        return f"unknown {label} field(s): {', '.join(sorted(unknown))}"
    missing = spec["required"] - set(obj)
    if missing:
        return f"missing {label} field(s): {', '.join(sorted(missing))}"
    return None


def validate_shape(intent: dict) -> GuardResult:
    if not isinstance(intent, dict):
        return False, "intent must be a JSON object"

    kind = intent.get("kind")
    if kind not in INTENT_KINDS:
        return False, f"unknown or unsupported kind: {kind!r}"

    spec = dict(_KIND_FIELDS[kind])
    spec = {"required": spec["required"], "optional": spec["optional"] | {"kind"}}
    err = _fields_check(intent, spec, label="intent")
    if err:
        return False, err

    oversized = _oversized_string_path(intent)
    if oversized:
        return False, f"{oversized} exceeds {_MAX_STRING_LEN} characters"

    if kind == ATTACH:
        if not isinstance(intent["book_id"], int) or isinstance(intent["book_id"], bool):
            return False, "attach.book_id must be an int"
        if "readalong" in intent and not isinstance(intent["readalong"], bool):
            return False, "attach.readalong must be a bool"

    elif kind == CREATE_BOOK:
        metadata = intent["metadata"]
        if not isinstance(metadata, dict):
            return False, "create_book.metadata must be an object"
        err = _fields_check(metadata, _METADATA_FIELDS, label="metadata")
        if err:
            return False, err
        if not isinstance(metadata.get("authors"), list) or not metadata["authors"]:
            return False, "metadata.authors must be a non-empty list"
        if "readalong" in intent and not isinstance(intent["readalong"], bool):
            return False, "create_book.readalong must be a bool"

    elif kind == ESCALATE:
        options = intent["options"]
        if not isinstance(options, list) or not (2 <= len(options) <= 6):
            return False, "escalate.options must be a list of 2-6 entries"
        for i, opt in enumerate(options):
            if not isinstance(opt, dict):
                return False, f"escalate.options[{i}] must be an object"
            err = _fields_check(opt, _OPTION_FIELDS, label=f"options[{i}]")
            if err:
                return False, err
            if not isinstance(opt.get("label"), str) or not opt["label"]:
                return False, f"escalate.options[{i}].label must be a non-empty string"

    elif kind == DEFER:
        nbh = intent["not_before_hours"]
        if not isinstance(nbh, int) or isinstance(nbh, bool) or not (1 <= nbh <= 168):
            return False, "defer.not_before_hours must be an int between 1 and 168"

    return True, "ok"


# --- GuardContext -------------------------------------------------------------


@dataclass
class GuardContext:
    dossier: dict
    index: object  # app.bookorbit.LibraryIndex, kept untyped to avoid an import cycle
    seen_ids: set
    run_claims: dict
    lists: KidsLists
    human_answer: dict | None = None


# --- helpers used by the guards ----------------------------------------------


def _primary_kind(dossier: dict) -> str | None:
    for f in dossier.get("trusted", {}).get("files", []):
        if f.get("primary"):
            return f.get("kind")
    return None


def _candidate_ids(dossier: dict) -> set:
    ids = set()
    for c in dossier.get("candidates", []):
        bid = (c.get("book") or {}).get("id")
        if bid is not None:
            ids.add(bid)
    return ids


def _has_conflicting_format(book, primary_kind) -> bool:
    if not book:
        return False
    files = book.get("files") or []
    if primary_kind == "m4b":
        return any(f.get("format") == "m4b" for f in files)
    if primary_kind == "epub":
        return any(
            f.get("format") == "epub"
            and not str(f.get("filename") or "").casefold().endswith("(readaloud).epub")
            for f in files
        )
    return False


def _targets_kids(intent: dict, kind: str, ctx: "GuardContext") -> bool:
    if kind == CREATE_BOOK:
        return intent.get("library") == "kids"
    if kind == ATTACH:
        book = ctx.index.book(intent["book_id"])
        return bool(book) and book.get("libraryName") == _KIDS_LIBRARY_NAME
    return False


# --- check_intent --------------------------------------------------------


def check_intent(intent: dict, ctx: GuardContext) -> GuardResult:
    shape_ok, shape_msg = validate_shape(intent)
    if not shape_ok:
        return False, shape_msg

    kind = intent["kind"]
    dossier = ctx.dossier
    trusted = dossier.get("trusted", {})
    primary_kind = _primary_kind(dossier)

    # Guard 1: referenced ids must exist in the real library, and an attach
    # target must be one this run is actually allowed to know about (a
    # dossier candidate, or an id already surfaced to the LLM this run) --
    # otherwise the LLM could file against a hallucinated or unrelated id.
    if kind == ATTACH:
        book_id = intent["book_id"]
        book = ctx.index.book(book_id)
        if book is None:
            return False, f"book_id {book_id} not found in the library index"
        if book_id not in _candidate_ids(dossier) and book_id not in ctx.seen_ids:
            return False, f"book_id {book_id} is not a candidate for this arrival or an id seen this run"

    # Guard 4: library must be adult|kids; CBZ arrivals may only escalate or
    # defer (no auto-filing for comics in this plan); Comics is never a
    # filing target.
    if kind == CREATE_BOOK and intent["library"] not in _LIBRARY_NAMES:
        return False, f"library must be 'adult' or 'kids', got {intent['library']!r}"
    if primary_kind == "cbz" and kind not in (ESCALATE, DEFER):
        return False, "cbz arrivals may only escalate or defer in this plan"
    if kind == ATTACH:
        book = ctx.index.book(intent["book_id"])
        if book and book.get("libraryName") == "Comics":
            return False, "target book is in the Comics library; comics are never a filing target"

    # Guard 5: don't attach a format the target already has.
    if kind == ATTACH:
        book = ctx.index.book(intent["book_id"])
        if _has_conflicting_format(book, primary_kind):
            return False, f"target book already has a {primary_kind} format"

    # Guard 6: one filing intent (attach/create_book) per arrival per run;
    # one arrival per (book, format) per run. escalate/defer never take a
    # claim (see claims_for) so they can't trip or be tripped by this guard.
    if kind in (ATTACH, CREATE_BOOK):
        if ("arrival", dossier["key"]) in ctx.run_claims:
            return False, "this arrival already has a filing intent this run"
    if kind == ATTACH:
        if ("book_fmt", intent["book_id"], primary_kind) in ctx.run_claims:
            return False, "another arrival already claimed this book+format this run"

    # Guard 7: filing into Kids needs a clean allow signal (allow >= 1,
    # deny == 0), or an explicit human "kids" decision that overrides the
    # denylist.
    override_note = ""
    if _targets_kids(intent, kind, ctx):
        kids = trusted.get("kids") or {}
        allow = kids.get("allow") or []
        deny = kids.get("deny") or []
        clean_allow = len(allow) >= 1 and len(deny) == 0
        human_override = bool(ctx.human_answer) and ctx.human_answer.get("choice") == "kids"
        if not clean_allow:
            if not human_override:
                return False, "kids filing needs an allowlist match with no denylist hit, or a human 'kids' decision"
            override_note = " (human choice overrides the kids denylist)"

    # Guard 8: a new book's rendered folder name must not collide with an
    # existing book already filed in the same target library.
    if kind == CREATE_BOOK:
        library_name = _LIBRARY_NAMES[intent["library"]]
        metadata = intent["metadata"]
        rendered = render_folder(
            metadata["authors"][0], metadata.get("series"), metadata.get("seriesIndex"), metadata["title"],
        )
        for book in ctx.index.books():
            if book.get("libraryName") != library_name:
                continue
            tail = _folder_tail(book.get("folderPath"), library_name)
            if tail is not None and tail.casefold() == rendered.casefold():
                return False, f"folder name {rendered!r} collides with an existing book in {library_name}"

    # Guard 10: don't attach when this dossier's measure disagrees on the
    # series index, unless a human has already weighed in on this arrival.
    if kind == ATTACH:
        measure = next(
            (m for m in trusted.get("measures", []) if m.get("book_id") == intent["book_id"]), None,
        )
        if measure and measure.get("series_index_agreement") == "disagree" and ctx.human_answer is None:
            return False, "series index disagreement for this book needs a human decision before attaching"

    return True, "ok" + override_note


# --- claims_for ---------------------------------------------------------


def claims_for(intent: dict, dossier: dict) -> list:
    """The `run_claims` keys an ACCEPTED intent takes.

    Only attach/create_book are filing intents (see guard 6): escalate and
    defer decide nothing about the book itself, so they take no claim and
    can neither block nor be blocked by this guard. The caller (Task 8)
    writes these keys into `run_claims` after a successful submit -- this
    function only computes which keys, never records anything itself.
    """
    kind = intent.get("kind")
    if kind not in (ATTACH, CREATE_BOOK):
        return []

    claims = [("arrival", dossier["key"])]
    if kind == ATTACH:
        claims.append(("book_fmt", intent["book_id"], _primary_kind(dossier)))
    return claims
