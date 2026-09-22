"""Title normalisation, colon keys, surnames, series parsing, edition flags.

Pure stdlib matching -- no network, no filesystem. Every helper is meant to
turn messy real-world audiobook/ebook metadata (filenames, ffprobe tags, OPF
dc:title/dc:creator, BookOrbit titles) into comparable keys so the librarian
can find candidate matches without depending on exact string equality.
"""
import re

# --- normalize ---------------------------------------------------------------

_PAREN_RE = re.compile(r"\([^)]*\)|\[[^\]]*\]")
# Leading `\s*` matters: callers frequently pass a colon-split fragment like
# " The Archimedes Engine" (the space right after the colon), so the article
# check must not require the article to sit at position 0.
_LEADING_ARTICLE_RE = re.compile(r"^\s*(the|a|an)\s+")
# `_` is explicitly punctuation here even though regex \w treats it as a word
# character -- "Star Wars_ Thrawn" (an underscore-for-colon filename artifact)
# must normalize the same as "Star Wars: Thrawn".
_PUNCT_RE = re.compile(r"[^\w\s]|_")
_WS_RE = re.compile(r"\s+")


def normalize(s: str) -> str:
    """Casefold, drop parentheticals, drop a leading article, `&`->`and`,
    strip punctuation to spaces, collapse whitespace."""
    if not s:
        return ""
    s = s.casefold()
    s = _PAREN_RE.sub(" ", s)
    s = s.replace("&", " and ")
    s = _LEADING_ARTICLE_RE.sub("", s)
    s = _PUNCT_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


# --- title_keys ----------------------------------------------------------

def title_keys(title: str, subtitle: str | None = None) -> set[str]:
    """All the normalized forms under which `title` might plausibly match a
    candidate: the whole title; each side of the first colon (normalized
    separately, so a leading article after the colon is dropped); the two
    sides joined; and title+subtitle when given. Each resulting key also
    contributes a variant with a trailing "unabridged" word removed."""
    keys: set[str] = set()

    def add(raw: str | None) -> None:
        if raw:
            n = normalize(raw)
            if n:
                keys.add(n)

    add(title)

    if title and ":" in title:
        before, _, after = title.partition(":")
        nb, na = normalize(before), normalize(after)
        if nb:
            keys.add(nb)
        if na:
            keys.add(na)
        combined = " ".join(p for p in (nb, na) if p)
        if combined:
            keys.add(combined)

    if subtitle:
        add(f"{title} {subtitle}")

    for k in list(keys):
        words = k.split(" ")
        if len(words) > 1 and words[-1] == "unabridged":
            keys.add(" ".join(words[:-1]))

    keys.discard("")
    return keys


# --- surname / surnames -------------------------------------------------------

_SUFFIX_RE = re.compile(r",?\s*(jr\.?|sr\.?|ii|iii)\.?\s*$", re.IGNORECASE)


def surname(author: str) -> str:
    """Handles `"Last, First"` and `"First M. Last"`; strips trailing
    generational suffixes before picking the last name."""
    if not author:
        return ""
    a = _SUFFIX_RE.sub("", author.strip()).strip()
    if "," in a:
        last = a.split(",", 1)[0]
    else:
        parts = a.split()
        last = parts[-1] if parts else ""
    return normalize(last)


def surnames(authors: list[str]) -> set[str]:
    return {s for a in authors for s in (surname(a),) if s}


# --- parse_series --------------------------------------------------------

_HASH_NUM_RE = re.compile(r"#\s*([\d.]+)\s*$")
_BOOK_NUM_RE = re.compile(r",?\s*book\s+([\d.]+)\s*$", re.IGNORECASE)


def parse_series(s: str | None) -> tuple[str | None, float | None]:
    """`"Murderbot Diaries #2"` -> `("murderbot diaries", 2.0)`;
    `"Foundation, Book 1"` -> `("foundation", 1.0)`; no number ->
    `(normalized or None, None)`."""
    if not s:
        return (None, None)

    number = None
    name_part = s
    m = _HASH_NUM_RE.search(s)
    if m:
        number = float(m.group(1))
        name_part = s[: m.start()]
    else:
        m = _BOOK_NUM_RE.search(s)
        if m:
            number = float(m.group(1))
            name_part = s[: m.start()]

    name = normalize(name_part)
    return (name or None, number)


# --- edition_flags --------------------------------------------------------

EDITION_PATTERNS = {
    "dramatized": re.compile(r"dramati[sz]ed", re.IGNORECASE),
    "full-cast": re.compile(r"full[- ]cast", re.IGNORECASE),
    "booktrack": re.compile(r"booktrack", re.IGNORECASE),
    # \b on both sides so this never matches inside "unabridged" (no word
    # boundary between the preceding "n" and "a").
    "abridged": re.compile(r"\babridged\b", re.IGNORECASE),
}


def edition_flags(*texts: str | None) -> list[str]:
    labels = set()
    for text in texts:
        if not text:
            continue
        for label, pattern in EDITION_PATTERNS.items():
            if pattern.search(text):
                labels.add(label)
    return sorted(labels)
