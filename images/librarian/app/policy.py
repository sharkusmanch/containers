"""Kids allow/deny lists, folder-name rendering, and submission guards.

`check_intent` is the hard, code-enforced boundary between an LLM's proposed
intent and any action the service will actually take: every field it
reasons about -- `ctx.dossier` (trusted-only sections), `ctx.index` (real
BookOrbit state), `ctx.run_claims` (this run's already-accepted intents),
`ctx.lists` (the GitOps-reviewed kids allow/denylists) -- is data this
module trusts, never the intent itself beyond its declared shape.
`validate_shape` runs first and rejects anything that doesn't match the
wire contract *and* type-checks every scalar so `check_intent` can never
crash on adversarial or merely-malformed LLM input; `check_intent` then
walks the numbered guards from spec section 3.4 (1, 4, 5, 6, 7, 8, 10 --
guards 2/3/9 are execution-time checks that ship with the Plan 2 executor).
`update_metadata` (Plan 2 Task 3) reuses guards 1/4/7 against its own
`book_id` -- the target-matches-this-run's-accepted-`attach` rule is
enforced by `app.intents.IntentBook.submit`, not here, since it needs the
intent store to find that attach's payload.

Recording claims into `ctx.run_claims` is NOT this module's job (see
`claims_for`) -- `check_intent` only reads `run_claims`, it never mutates it.
The caller (the intent submission path, Task 8) is responsible for calling
`claims_for` on an accepted intent and writing the returned keys into the
run's claim table under `core.lock`.

Kids is a content boundary, not a convenience gate: a wrong filing into Kids
is worse than a delay. Guard 7 therefore (a) fails CLOSED -- a malformed
allow/denylist file blocks every kids filing rather than being treated as
empty (only a genuinely *missing* file means "no entries") -- and (b) never
trusts a dossier's baked-in kids signals alone, since the dossier may have
been built before the lists last changed: it recomputes fresh signals
against `ctx.lists` from the arrival's own untrusted-but-safe-to-match
inputs (series/asins/author names -- normalized set-membership checks only,
never free text) at check time, and denies if EITHER the stored or the
fresh computation has a deny hit.
"""
import math
import os
import json
from dataclasses import dataclass, field

from app.dossier import agreement
from app.states import ATTACH, CREATE_BOOK, DEFER, ESCALATE, INTENT_KINDS, UPDATE_METADATA
from app.titles import normalize

GuardResult = tuple[bool, str]

# adult/kids are the only intent-facing library names; "Comics" (BookOrbit id
# 3) is never a filing target per the plan's global constraints. Guard 4 is
# an ALLOWLIST of real BookOrbit library names an attach may target -- not a
# blocklist of "Comics" -- so a missing/unexpected libraryName (a renamed or
# unknown library) is rejected the same as Comics.
_LIBRARY_NAMES = {"adult": "Library", "kids": "Kids Audiobooks"}
_KIDS_LIBRARY_NAME = "Kids Audiobooks"
_ALLOWED_TARGET_LIBRARY_NAMES = frozenset(_LIBRARY_NAMES.values())

_MAX_STRING_LEN = 2000
_MAX_LIST_LEN = 20

# update_metadata's lock list (Global "Metadata locks"): series stays
# unlocked, so only these three may ever be requested.
_UPDATE_METADATA_LOCK_FIELDS = frozenset({"title", "subtitle", "description"})

# NUL and other C0 control characters, plus DEL -- never legitimate in a
# filesystem path segment and a classic injection vector if let through into
# render_folder() unfiltered.
_CONTROL_CHARS = frozenset(chr(c) for c in range(0x20)) | {chr(0x7F)}


# --- KidsLists / kids_signals ------------------------------------------------


@dataclass
class _KidsList:
    series: set = field(default_factory=set)
    asins: set = field(default_factory=set)
    # (normalized name, whole_author) pairs; whole_author is always a real
    # bool by the time it lands here -- see _validate_kids_data.
    authors: list = field(default_factory=list)
    valid: bool = True
    error: str | None = None


def _norm_asin(a) -> str:
    return str(a).strip().casefold()


def _validate_kids_data(data) -> str | None:
    """Structural validation for a parsed kids list file. Returns an error
    string naming the problem, or None if the shape is acceptable. This is
    intentionally strict -- content policy for a Kids library fails CLOSED,
    so any shape surprise (not just a JSON syntax error) must invalidate the
    file rather than be silently coerced into "no entries"."""
    if not isinstance(data, dict):
        return "root must be a JSON object"

    for key in ("series", "asins"):
        if key in data:
            val = data[key]
            if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                return f"{key!r} must be a list of strings"

    if "authors" in data:
        authors = data["authors"]
        if not isinstance(authors, list):
            return "'authors' must be a list"
        for a in authors:
            if not isinstance(a, dict) or not isinstance(a.get("name"), str):
                return "'authors' entries must be objects with a string 'name'"
            if "whole_author" in a and not isinstance(a["whole_author"], bool):
                return "'authors[].whole_author' must be a bool"

    return None


def _load_kids_list(lists_dir, filename) -> _KidsList:
    """Load one list file. A MISSING file means empty (a brand new cluster
    ships with no lists yet); anything else that goes wrong -- unreadable,
    invalid JSON, or valid JSON in the wrong shape -- marks the list invalid
    with a human-readable reason, and never raises."""
    path = os.path.join(str(lists_dir), filename)
    try:
        with open(path) as f:
            raw = f.read()
    except FileNotFoundError:
        return _KidsList()
    except (OSError, UnicodeDecodeError) as e:
        return _KidsList(valid=False, error=f"{filename}: cannot read file ({e})")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return _KidsList(valid=False, error=f"{filename}: invalid JSON ({e})")

    try:
        err = _validate_kids_data(data)
        if err:
            return _KidsList(valid=False, error=f"{filename}: {err}")

        series = {normalize(s) for s in data.get("series", []) if normalize(s)}
        asins = {_norm_asin(a) for a in data.get("asins", []) if a}
        authors = [
            (normalize(a.get("name", "")), a.get("whole_author") is True)
            for a in data.get("authors", [])
            if normalize(a.get("name", ""))
        ]
        return _KidsList(series=series, asins=asins, authors=authors)
    except Exception as e:  # never raise from load -- fail closed instead
        return _KidsList(valid=False, error=f"{filename}: {e}")


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

    @property
    def valid(self) -> bool:
        return self.allow.valid and self.deny.valid

    @property
    def error(self) -> str | None:
        errs = [lst.error for lst in (self.allow, self.deny) if not lst.valid and lst.error]
        return "; ".join(errs) if errs else None


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


def _safe_kids_inputs(dossier: dict) -> dict:
    """The EXACT series/asins/authors `app.dossier.build_dossier` used for
    its own kids_signals call, read back from `untrusted.kids_inputs`.

    Fix round 2: guard 7 previously RE-DERIVED these itself from raw tag
    text (e.g. taking a "series" tag verbatim from the first file that had
    one). That diverged from build_dossier's real computation -- which
    uses only the PRIMARY file's series/album tag, run through
    `app.titles.parse_series` to strip a trailing "#2"/", Book 2" and
    normalize the rest -- so a tag like "Murderbot Diaries #2" would
    normalize to "murderbot diaries 2" here but "murderbot diaries" in the
    dossier's own (correct) computation, silently missing every
    allow/deny-list series match. Guard 7 must reuse build_dossier's own
    answer, not recompute a different one.

    Defensively re-validates types (a dossier file on disk may predate this
    fix, or may itself be malformed) so a bad "asins"/"authors" shape can
    never crash this guard -- see fix round 2 minor: a sidecar with a
    non-string "asin" or a non-list "authors" must be ignored, not raise or
    get exploded into individual characters.
    """
    raw = (dossier.get("untrusted") or {}).get("kids_inputs") or {}

    series = raw.get("series")
    series = series if isinstance(series, str) else None

    asins_raw = raw.get("asins")
    asins = tuple(a for a in asins_raw if isinstance(a, str)) if isinstance(asins_raw, list) else ()

    authors_raw = raw.get("authors")
    authors = tuple(a for a in authors_raw if isinstance(a, str)) if isinstance(authors_raw, list) else ()

    return {"series": series, "asins": asins, "authors": authors}


# --- render_folder -----------------------------------------------------------


def _format_index(idx) -> str:
    """2.0 -> "2", 2.5 -> "2.5" -- repr-based so we never emit scientific
    notation the way `%g`/`str(float)` can for larger magnitudes."""
    s = repr(float(idx))
    if s.endswith(".0"):
        s = s[:-2]
    return s


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


def _path_segment_error(value: str, field: str) -> str | None:
    """Folder-name-bound fields (title, subtitle, series, first author) must
    never be able to escape their intended path segment or smuggle control
    bytes into a filesystem path built from them."""
    if "/" in value or "\\" in value:
        return f"{field} must not contain '/' or '\\\\'"
    if value == "..":
        return f"{field} must not be '..'"
    if any(ch in _CONTROL_CHARS for ch in value):
        return f"{field} must not contain control characters"
    if value != value.strip():
        return f"{field} must not have leading or trailing whitespace"
    return None


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
    UPDATE_METADATA: {"required": {"arrival", "book_id", "metadata", "lock", "reason"}, "optional": set()},
}

# metadata fields that must be a string when present (title is required and
# checked separately so its "non-empty" rule has its own message).
_METADATA_STRING_FIELDS = ("subtitle", "series", "language", "audibleId", "asinTag")
# of those, the ones that also feed render_folder and so need path-safety.
_METADATA_PATH_FIELDS = ("subtitle", "series")


def _is_finite_number(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


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


def _validate_attach(intent: dict) -> str | None:
    if not isinstance(intent["book_id"], int) or isinstance(intent["book_id"], bool):
        return "attach.book_id must be an int"
    if not isinstance(intent["reason"], str) or not intent["reason"]:
        return "attach.reason must be a non-empty string"
    if "readalong" in intent and not isinstance(intent["readalong"], bool):
        return "attach.readalong must be a bool"
    return None


def _validate_metadata_body(metadata: dict, *, require_title_and_authors: bool) -> str | None:
    """Field checks shared by create_book (title/authors required) and
    update_metadata (every field optional, but at least one must be
    present -- checked by the caller): same allowed key set either way,
    only the required subset differs."""
    all_fields = _METADATA_FIELDS["required"] | _METADATA_FIELDS["optional"]
    required = _METADATA_FIELDS["required"] if require_title_and_authors else set()
    err = _fields_check(metadata, {"required": required, "optional": all_fields - required}, label="metadata")
    if err:
        return err

    if require_title_and_authors or "title" in metadata:
        if not isinstance(metadata.get("title"), str) or not metadata.get("title"):
            return "metadata.title must be a non-empty string"
        err = _path_segment_error(metadata["title"], "metadata.title")
        if err:
            return err

    if require_title_and_authors or "authors" in metadata:
        authors = metadata.get("authors")
        if not isinstance(authors, list) or not authors:
            return "metadata.authors must be a non-empty list"
        if len(authors) > _MAX_LIST_LEN:
            return f"metadata.authors must have at most {_MAX_LIST_LEN} entries"
        if not all(isinstance(a, str) and a for a in authors):
            return "metadata.authors entries must all be non-empty strings"
        err = _path_segment_error(authors[0], "metadata.authors[0]")
        if err:
            return err

    for field_name in _METADATA_STRING_FIELDS:
        val = metadata.get(field_name)
        if val is not None and not isinstance(val, str):
            return f"metadata.{field_name} must be a string"
    for field_name in _METADATA_PATH_FIELDS:
        val = metadata.get(field_name)
        if val:
            err = _path_segment_error(val, f"metadata.{field_name}")
            if err:
                return err

    for field_name in ("seriesIndex", "publishedYear"):
        val = metadata.get(field_name)
        if val is not None and not _is_finite_number(val):
            return f"metadata.{field_name} must be a finite number"

    narrators = metadata.get("narrators")
    if narrators is not None:
        if not isinstance(narrators, list):
            return "metadata.narrators must be a list"
        if len(narrators) > _MAX_LIST_LEN:
            return f"metadata.narrators must have at most {_MAX_LIST_LEN} entries"
        if not all(isinstance(n, str) and n for n in narrators):
            return "metadata.narrators entries must all be non-empty strings"

    return None


def _validate_create_book(intent: dict) -> str | None:
    if not isinstance(intent["library"], str):
        return "create_book.library must be a string"
    if not isinstance(intent["reason"], str) or not intent["reason"]:
        return "create_book.reason must be a non-empty string"
    if "readalong" in intent and not isinstance(intent["readalong"], bool):
        return "create_book.readalong must be a bool"

    metadata = intent["metadata"]
    if not isinstance(metadata, dict):
        return "create_book.metadata must be an object"
    return _validate_metadata_body(metadata, require_title_and_authors=True)


def _validate_update_metadata(intent: dict) -> str | None:
    if not isinstance(intent["book_id"], int) or isinstance(intent["book_id"], bool):
        return "update_metadata.book_id must be an int"
    if not isinstance(intent["reason"], str) or not intent["reason"]:
        return "update_metadata.reason must be a non-empty string"

    metadata = intent["metadata"]
    if not isinstance(metadata, dict):
        return "update_metadata.metadata must be an object"
    if not metadata:
        return "update_metadata.metadata must have at least one field"
    err = _validate_metadata_body(metadata, require_title_and_authors=False)
    if err:
        return err

    lock = intent["lock"]
    if not isinstance(lock, list) or not all(isinstance(x, str) for x in lock):
        return "update_metadata.lock must be a list of strings"
    bad = sorted(set(lock) - _UPDATE_METADATA_LOCK_FIELDS)
    if bad:
        return (f"update_metadata.lock may only contain "
                f"{sorted(_UPDATE_METADATA_LOCK_FIELDS)}: got {bad}")

    return None


def _validate_escalate(intent: dict) -> str | None:
    if not isinstance(intent["question"], str) or not intent["question"]:
        return "escalate.question must be a non-empty string"
    if not isinstance(intent["recommendation"], str) or not intent["recommendation"]:
        return "escalate.recommendation must be a non-empty string"

    options = intent["options"]
    if not isinstance(options, list) or not (2 <= len(options) <= 6):
        return "escalate.options must be a list of 2-6 entries"
    for i, opt in enumerate(options):
        if not isinstance(opt, dict):
            return f"escalate.options[{i}] must be an object"
        err = _fields_check(opt, _OPTION_FIELDS, label=f"options[{i}]")
        if err:
            return err
        if not isinstance(opt.get("label"), str) or not opt["label"]:
            return f"escalate.options[{i}].label must be a non-empty string"
        if "intent" in opt and opt["intent"] is not None and not isinstance(opt["intent"], dict):
            return f"escalate.options[{i}].intent must be an object"
    return None


def _validate_defer(intent: dict) -> str | None:
    if not isinstance(intent["reason"], str) or not intent["reason"]:
        return "defer.reason must be a non-empty string"
    nbh = intent["not_before_hours"]
    if not isinstance(nbh, int) or isinstance(nbh, bool) or not (1 <= nbh <= 168):
        return "defer.not_before_hours must be an int between 1 and 168"
    return None


_KIND_VALIDATORS = {
    ATTACH: _validate_attach,
    CREATE_BOOK: _validate_create_book,
    ESCALATE: _validate_escalate,
    DEFER: _validate_defer,
    UPDATE_METADATA: _validate_update_metadata,
}


def validate_shape(intent: dict) -> GuardResult:
    if not isinstance(intent, dict):
        return False, "intent must be a JSON object"

    kind = intent.get("kind")
    if kind not in INTENT_KINDS:
        return False, f"unknown or unsupported kind: {kind!r}"

    spec = _KIND_FIELDS[kind]
    err = _fields_check(intent, {"required": spec["required"], "optional": spec["optional"] | {"kind"}},
                         label="intent")
    if err:
        return False, err

    oversized = _oversized_string_path(intent)
    if oversized:
        return False, f"{oversized} exceeds {_MAX_STRING_LEN} characters"

    # "arrival" is common to every kind and every downstream guard relies on
    # it being a real string (guard 6 uses it as a run_claims key).
    if not isinstance(intent.get("arrival"), str) or not intent["arrival"]:
        return False, "arrival must be a non-empty string"

    err = _KIND_VALIDATORS[kind](intent)
    if err:
        return False, err

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
        return any(str(f.get("format") or "").casefold() == "m4b" for f in files)
    if primary_kind == "epub":
        return any(
            str(f.get("format") or "").casefold() == "epub"
            and not str(f.get("filename") or "").casefold().endswith("(readaloud).epub")
            for f in files
        )
    return False


def _targets_kids(intent: dict, kind: str, ctx: "GuardContext") -> bool:
    if kind == CREATE_BOOK:
        return intent.get("library") == "kids"
    if kind in (ATTACH, UPDATE_METADATA):
        book = ctx.index.book(intent["book_id"])
        return bool(book) and book.get("libraryName") == _KIDS_LIBRARY_NAME
    return False


def _valid_human_answer(human_answer) -> bool:
    """A human has genuinely weighed in on this arrival: a dict with a
    non-empty `choice`. Anything else (None, a bare string, an empty dict,
    an empty choice) does not count -- guards 7 and 10 must not treat
    adversarial or malformed input as a human decision."""
    return isinstance(human_answer, dict) and bool(human_answer.get("choice"))


def _human_kids_override(human_answer) -> bool:
    return _valid_human_answer(human_answer) and human_answer.get("choice") == "kids"


# --- check_intent --------------------------------------------------------


def check_intent(intent: dict, ctx: GuardContext) -> GuardResult:
    shape_ok, shape_msg = validate_shape(intent)
    if not shape_ok:
        return False, shape_msg

    kind = intent["kind"]
    dossier = ctx.dossier
    trusted = dossier.get("trusted", {})
    primary_kind = _primary_kind(dossier)

    # Guard: an intent must be about the arrival it was dispatched for --
    # never let an LLM file a decision made for one arrival's dossier
    # against a different arrival's key.
    if intent["arrival"] != dossier.get("key"):
        return False, "intent.arrival does not match the arrival this dossier is for"

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

    # update_metadata's book_id must be a real book too -- unlike attach it
    # was never offered as a dossier candidate (it's the arrival's OWN
    # attach target), so there is no candidate/seen check here; the rule
    # that it must equal THIS run's accepted attach for THIS arrival is
    # enforced by app.intents.IntentBook.submit, which has the intent
    # store this module does not.
    if kind == UPDATE_METADATA:
        book_id = intent["book_id"]
        book = ctx.index.book(book_id)
        if book is None:
            return False, f"book_id {book_id} not found in the library index"

    # Guard 4: library must be adult|kids; CBZ arrivals may only escalate or
    # defer (no auto-filing for comics in this plan); an attach target must
    # be one of the two real filing libraries (an ALLOWLIST, not merely
    # "not Comics" -- a missing/renamed/unknown libraryName is rejected too).
    if kind == CREATE_BOOK and intent["library"] not in _LIBRARY_NAMES:
        return False, f"library must be 'adult' or 'kids', got {intent['library']!r}"
    if primary_kind == "cbz" and kind not in (ESCALATE, DEFER):
        return False, "cbz arrivals may only escalate or defer in this plan"
    if kind in (ATTACH, UPDATE_METADATA):
        book = ctx.index.book(intent["book_id"])
        lib_name = book.get("libraryName") if book else None
        if lib_name not in _ALLOWED_TARGET_LIBRARY_NAMES:
            return False, f"target book's library {lib_name!r} is not a valid filing target"

    # Guard 5: don't attach a format the target already has, and don't
    # attach an arrival whose primary file isn't one of the two attachable
    # formats in the first place (format comparisons are case-insensitive).
    if kind == ATTACH:
        if primary_kind not in ("m4b", "epub"):
            return False, f"attach requires an m4b or epub primary file, arrival's primary is {primary_kind!r}"
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

    # Guard 7: filing into Kids needs a clean, FRESH allow signal (recomputed
    # against ctx.lists right now, not just whatever the dossier baked in
    # when it was built) with no deny hit from either the stored or the
    # fresh computation -- or an explicit human "kids" decision that
    # overrides the denylist. A malformed allow/denylist file fails CLOSED:
    # every kids filing is refused, no override, until the file is fixed.
    override_note = ""
    if _targets_kids(intent, kind, ctx):
        if not ctx.lists.valid:
            return False, f"kids lists failed validation, refusing all kids filings: {ctx.lists.error}"

        stored_kids = trusted.get("kids") or {}
        stored_deny_hit = bool(stored_kids.get("deny"))

        inputs = _safe_kids_inputs(dossier)
        fresh = kids_signals(ctx.lists, series=inputs["series"], asins=inputs["asins"],
                              authors=inputs["authors"])
        fresh_deny_hit = bool(fresh["deny"])
        fresh_allow_hit = bool(fresh["allow"])

        deny_hit = stored_deny_hit or fresh_deny_hit
        needs_override = deny_hit or not fresh_allow_hit
        human_override = _human_kids_override(ctx.human_answer)

        if needs_override and not human_override:
            return False, ("kids filing needs a fresh allowlist hit and no denylist hit "
                            "(stored or fresh), or a human 'kids' decision")
        if needs_override:  # human_override is true here
            reasons = []
            if deny_hit:
                reasons.append("a denylist hit")
            if not fresh_allow_hit:
                reasons.append("a missing allowlist hit")
            override_note = f" (human 'kids' choice overrides {' and '.join(reasons)})"

    # Guard 8: a new book's rendered folder name must not collide with an
    # existing book already filed in the same target library, NOR with
    # another create_book this same run already claimed the folder for
    # (review amendment: `claims_for` records a `("folder", ...)` claim on
    # every accepted create_book, so two create_books proposed in one run
    # can't both render to the same folder before either is a real book).
    if kind == CREATE_BOOK:
        library_name = _LIBRARY_NAMES[intent["library"]]
        metadata = intent["metadata"]
        rendered = render_folder(
            metadata["authors"][0], metadata.get("series"), metadata.get("seriesIndex"), metadata["title"],
        )
        if ("folder", library_name, rendered.casefold()) in ctx.run_claims:
            return False, f"folder name {rendered!r} was already claimed by another create_book this run"
        for book in ctx.index.books():
            if book.get("libraryName") != library_name:
                continue
            tail = _folder_tail(book.get("folderPath"), library_name)
            if tail is not None and tail.casefold() == rendered.casefold():
                return False, f"folder name {rendered!r} collides with an existing book in {library_name}"

    # Guard 10: don't attach when the series index disagrees, unless a human
    # has already weighed in on this arrival. Prefer the dossier's own
    # measure (already computed against this run's exact candidate list);
    # for a book with no measure -- e.g. one the LLM found via search_books
    # rather than a ranked candidate -- recompute the same agreement from
    # the arrival's own series index (dossier.agreement is the same
    # function build_dossier used) against the index book's seriesIndex.
    if kind == ATTACH:
        book_id = intent["book_id"]
        measure = next(
            (m for m in trusted.get("measures", []) if m.get("book_id") == book_id), None,
        )
        if measure is not None:
            disagree = measure.get("series_index_agreement") == "disagree"
        else:
            book = ctx.index.book(book_id)
            arrival_idx = trusted.get("arrival_series_index")
            cand_idx = (book or {}).get("seriesIndex")
            disagree = agreement(arrival_idx, cand_idx) == "disagree"
        if disagree and not _valid_human_answer(ctx.human_answer):
            return False, "series index disagreement for this book needs a human decision before attaching"

    return True, "ok" + override_note


# --- claims_for ---------------------------------------------------------


def claims_for(intent: dict, dossier: dict) -> list:
    """The `run_claims` keys an ACCEPTED intent takes.

    Only attach/create_book are filing intents (see guard 6): escalate and
    defer decide nothing about the book itself, so they take no claim and
    can neither block nor be blocked by this guard. update_metadata takes
    no claim here either -- its own one-per-arrival ("meta", arrival) claim
    and its attach-linkage check are recorded/enforced by
    `app.intents.IntentBook.submit`, which needs the intent store (this
    function only ever sees one intent + its dossier). The caller (Task 8)
    writes these keys into `run_claims` after a successful submit -- this
    function only computes which keys, never records anything itself.
    """
    kind = intent.get("kind")
    if kind not in (ATTACH, CREATE_BOOK):
        return []

    claims = [("arrival", dossier["key"])]
    if kind == ATTACH:
        claims.append(("book_fmt", intent["book_id"], _primary_kind(dossier)))
    if kind == CREATE_BOOK:
        library_name = _LIBRARY_NAMES[intent["library"]]
        metadata = intent["metadata"]
        rendered = render_folder(
            metadata["authors"][0], metadata.get("series"), metadata.get("seriesIndex"), metadata["title"],
        )
        claims.append(("folder", library_name, rendered.casefold()))
    return claims
