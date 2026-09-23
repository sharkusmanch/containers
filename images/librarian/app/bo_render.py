"""BookOrbit 3.0.0's file-naming renderer, ported line for line (Task 9c).

BookOrbit decides where a book lives: after every metadata PATCH that
carries a rename-relevant field it renders the library's
`fileNamingPattern` and moves the book there (~3 s later). Guard 8 must
therefore predict that exact path, so this module replicates BookOrbit's
own code rather than approximating it. Source, read from the running
image (`kubectl exec -n media deploy/bookorbit`):

  /app/node_modules/.pnpm/@bookorbit+types@file+packages+types/
      node_modules/@bookorbit/types/src/series-index.ts
        parseSeriesIndex / isValidSeriesIndex (l.1-14),
        formatSeriesIndex (l.50-56): whole part padStart(2, "0")
      node_modules/@bookorbit/types/src/pattern-resolver.ts
        applyModifier (l.75-114), resolveModifierPlaceholders (l.116-121),
        checkAllPlaceholdersPresent (l.123-130), replacePlaceholders
        (l.132-146), sanitizePathSegment (l.160-172),
        stripTrailingDotsAndSpaces (l.174-178), normalizeResolvedSegments
        (l.187-194), sanitizeResolutionValues (l.196-205), extension
        handling (l.207-227), truncatePathSegment / hashSegment
        (l.229-284), resolveUploadPath (l.293-307)
  /app/dist/common/utils/pattern-tokens.utils.js  buildPatternTokens (l.12-30)
  /app/dist/modules/file-write/file-rename.service.js
        RENAME_RELEVANT_FIELDS (l.66-72), performRenameLocked (l.107-285):
        target = path.join(libraryFolderPath, resolvedRelPath); the book
        folder is its dirname; `sanitizeForCrossPlatform` comes from the
        app setting cross_platform_path_sanitization_enabled (true live).

Both filing libraries (7 and 8) use PATTERN below (GET /libraries/{id},
2026-09-23) with organizationMode book_per_folder.
"""
import posixpath
import re

PATTERN = "{authors:first}/<{series}/><{seriesIndex}. >{title}/<{seriesIndex}. >{title}"
SANITIZE = True          # app setting cross_platform_path_sanitization_enabled

# file-rename.service.js l.66-72: a PATCH carrying any of these (even
# unchanged, even null) schedules the async rename.
RENAME_RELEVANT_FIELDS = ("title", "authors", "seriesName", "seriesIndex", "publishedYear")

SERIES_INDEX_MAX_LENGTH = 20
_SERIES_INDEX_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")        # JS \d is ASCII-only
MAX_PATH_SEGMENT_BYTES = 255
_MODIFIER_PLACEHOLDER_RE = re.compile(r"\{([^}:]+)(?::([^}]+))?}")
_BLOCK_RE = re.compile(r"<([^<>]+)>")
_INVALID_SEGMENT_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = frozenset(["CON", "PRN", "AUX", "NUL"] + [f"COM{i}" for i in range(1, 10)]
                              + [f"LPT{i}" for i in range(1, 10)])
# String.prototype.trim(): WhiteSpace + LineTerminator (ECMA-262). Python's
# str.strip() differs (it strips \x1c-\x1f and not ﻿), so spell it out.
_JS_WS = ("\t\n\v\f\r          "
          "        　﻿")


def js_trim(s: str) -> str:
    return s.strip(_JS_WS)


def _js_number_string(v) -> str:
    """String(number) for the finite values we can meet (ints and plain floats)."""
    if isinstance(v, bool):
        raise TypeError("bool is not a series index")
    if isinstance(v, int):
        return str(v)
    f = float(v)
    if f != f or f in (float("inf"), float("-inf")):
        return ""
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    return repr(f)


# --- series-index.ts ---------------------------------------------------------------

def parse_series_index(value):
    if isinstance(value, str):
        candidate = js_trim(value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        candidate = _js_number_string(value)
    else:
        candidate = ""
    if len(candidate) <= SERIES_INDEX_MAX_LENGTH and _SERIES_INDEX_RE.match(candidate):
        return candidate
    return None


def format_series_index(value):
    parsed = parse_series_index(value)
    if parsed is None:
        return None
    whole, _, fraction = parsed.partition(".")
    padded = whole.rjust(2, "0")
    return padded if "." not in parsed else f"{padded}.{fraction}"


# --- pattern-resolver.ts -----------------------------------------------------------

def apply_modifier(value: str, modifier: str, field_name: str) -> str:
    if not value:
        return value
    if modifier == "first":
        return js_trim(value.split(", ")[0])
    if modifier == "sort":
        first = js_trim(value.split(", ")[0])
        last = first.rfind(" ")
        return f"{first[last + 1:]}, {first[:last]}" if last > 0 else first
    if modifier == "initial":
        target = value
        if field_name == "authors":
            first = js_trim(value.split(", ")[0])
            last = first.rfind(" ")
            target = first[last + 1:] if last > 0 else first
        return target[:1].upper()
    if modifier == "max3":
        parts = [p for p in (js_trim(x) for x in value.split(", ")) if p]
        return "" if len(parts) > 3 else ", ".join(parts)
    if modifier == "upper":
        return value.upper()
    if modifier == "lower":
        return value.lower()
    if modifier == "fixed2":
        if not _SERIES_INDEX_RE.match(value):
            return value
        whole, _, fraction = value.partition(".")
        return f"{whole}.{fraction.ljust(2, '0')}"
    return value


def _resolve_modifier_placeholders(block: str, values: dict) -> str:
    def sub(m):
        val = values.get(m.group(1), "")
        return apply_modifier(val, m.group(2), m.group(1)) if m.group(2) else val
    return _MODIFIER_PLACEHOLDER_RE.sub(sub, block)


def _all_placeholders_present(block: str, values: dict) -> bool:
    for m in _MODIFIER_PLACEHOLDER_RE.finditer(block):
        raw = values.get(m.group(1), "")
        if not js_trim(raw):
            return False
        v = apply_modifier(raw, m.group(2), m.group(1)) if m.group(2) else raw
        if not js_trim(v):
            return False
    return True


def replace_placeholders(pattern: str, values: dict) -> str:
    def block(m):
        content = m.group(1)
        pipe = content.find("|")
        primary = content[:pipe] if pipe >= 0 else content
        fallback = content[pipe + 1:] if pipe >= 0 else None
        if _all_placeholders_present(primary, values):
            return _resolve_modifier_placeholders(primary, values)
        return _resolve_modifier_placeholders(fallback, values) if fallback is not None else ""
    pattern = _BLOCK_RE.sub(block, pattern)
    return js_trim(_resolve_modifier_placeholders(pattern, values))


def _strip_trailing_dots_and_spaces(value: str) -> str:
    return value.rstrip(". ")


def sanitize_path_segment(value: str, repl: str = "_") -> str:
    s = _strip_trailing_dots_and_spaces(js_trim(_INVALID_SEGMENT_CHARS_RE.sub(repl, value)))
    if not s or s in (".", ".."):
        s = repl
    if s.split(".")[0].upper() in _WINDOWS_RESERVED:
        s = f"{s}{repl}"
    return s


def _normalize_resolved_segments(path: str, sanitize: bool, repl: str) -> str:
    if not sanitize or not path:
        return path
    return "/".join((_strip_trailing_dots_and_spaces(seg) or repl) if seg else seg
                    for seg in path.split("/"))


def _sanitize_values(values: dict, sanitize: bool, repl: str) -> dict:
    if not sanitize:
        return values
    return {k: (sanitize_path_segment(v, repl) if js_trim(v) else "") for k, v in values.items()}


def _dot_ext(ext: str) -> str:
    t = js_trim(ext)
    if not t:
        return ""
    bare = t[1:] if t.startswith(".") else t
    return f".{bare}" if bare else ""


def _ensure_ext(value: str, dot_ext: str) -> str:
    if not dot_ext:
        return value
    return value if value.lower().endswith(dot_ext.lower()) else f"{value}{dot_ext}"


def _utf8_len(value: str) -> int:
    n = 0
    for ch in value:
        cp = ord(ch)
        n += 1 if cp <= 0x7F else 2 if cp <= 0x7FF else 3 if cp <= 0xFFFF else 4
    return n


def _truncate_utf8(value: str, max_bytes: int) -> str:
    out, used = [], 0
    for ch in value:
        b = _utf8_len(ch)
        if used + b > max_bytes:
            break
        out.append(ch)
        used += b
    return "".join(out)


def _hash_segment(value: str) -> str:
    h = 0x811C9DC5
    for ch in value:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF          # Math.imul(...) >>> 0
    return format(h, "08x")


def _truncate_segment(segment: str, suffix: str = "") -> str:
    if not segment or _utf8_len(segment) <= MAX_PATH_SEGMENT_BYTES:
        return segment
    preserved = segment[-len(suffix):] if suffix and segment.lower().endswith(suffix.lower()) else ""
    stem = segment[:-len(preserved)] if preserved else segment
    tail = f"~{_hash_segment(segment)}"
    budget = MAX_PATH_SEGMENT_BYTES - (_utf8_len(tail) + _utf8_len(preserved))
    if budget <= 0:
        return _truncate_utf8(segment, MAX_PATH_SEGMENT_BYTES)
    return f"{_truncate_utf8(stem, budget)}{tail}{preserved}"


def _limit_segment_bytes(path: str, dot_ext: str) -> str:
    segs = path.split("/")
    last = len(segs) - 1
    return "/".join(_truncate_segment(s, dot_ext if i == last else "") for i, s in enumerate(segs))


def resolve_upload_path(pattern: str, values: dict, ext: str, sanitize: bool = SANITIZE,
                        repl: str = "_"):
    """resolveUploadPath: the relative path (no leading slash), or None."""
    vals = _sanitize_values(values, sanitize, repl)
    resolved = _normalize_resolved_segments(replace_placeholders(pattern, vals), sanitize, repl)
    if not resolved:
        return None
    dot_ext = _dot_ext(ext)
    if resolved.endswith("/"):
        return _limit_segment_bytes(resolved + _ensure_ext(vals.get("originalFilename", "upload"),
                                                           dot_ext), dot_ext)
    segs = resolved.split("/")
    segs[-1] = _ensure_ext(segs[-1], dot_ext)
    return _limit_segment_bytes("/".join(segs), dot_ext)


# --- pattern-tokens.utils.js ---------------------------------------------------------

def pattern_tokens(*, title=None, subtitle=None, authors=(), series=None, series_index=None,
                   published_year=None, language=None, original_stem="", fmt="") -> dict:
    tokens = {"originalFilename": original_stem, "extension": fmt}
    if title:
        tokens["title"] = title
    if subtitle:
        tokens["subtitle"] = subtitle
    if language:
        tokens["language"] = language
    if published_year:
        tokens["year"] = _js_number_string(published_year) if not isinstance(published_year, str) \
            else published_year
    if series:
        tokens["series"] = series
    idx = format_series_index(series_index)
    if idx:
        tokens["seriesIndex"] = idx
    if authors:
        tokens["authors"] = ", ".join(authors)
    return tokens


# --- what the librarian needs ---------------------------------------------------------

def render_book_path(authors, series, series_index, title, ext: str, original_stem: str = ""):
    """The book's primary file path relative to the library root, exactly as
    BookOrbit renders it (path.join-normalised), or None when the pattern
    resolves to nothing."""
    if isinstance(authors, str):
        authors = [authors]
    fmt = ext.lstrip(".").lower()
    rel = resolve_upload_path(PATTERN, pattern_tokens(title=title, authors=list(authors or []),
                                                      series=series, series_index=series_index,
                                                      original_stem=original_stem, fmt=fmt), fmt)
    if rel is None:
        return None
    # path.join(libraryFolderPath, rel) collapses "//" and "." segments
    norm = posixpath.normpath("/" + rel).lstrip("/")
    return norm or None
