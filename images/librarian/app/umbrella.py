"""Umbrella series: a series that spans other series (2026-09-24).

A BookOrbit book can belong to several series. The first membership (display order 0) is the
primary: BookOrbit mirrors it into seriesName/seriesIndex and names the folder after it. Every
further membership is an extra that never moves a file. An umbrella (The Cosmere, The Realm of the
Elderlings, First Law World, The Mistborn Saga) is held as an extra, so a book keeps its own series
-- The Stormlight Archive #1 plus The Cosmere #6 -- and is not filed under the umbrella's name.
The exception is a standalone with no more specific series (Elantris: The Cosmere #1; Best Served
Cold: First Law World #4); filing a new one that way takes a human's answer.

Mirror of the books repo's scripts/bookorbit/umbrella.py (which also carries the audit's exception
lists and pinned positions): keep the member series and aliases of both in step. Positions come from
Goodreads there, by hand; a new filing gets its umbrellas WITHOUT a position (never invented) and the
audit asks for them.

BookOrbit semantics this relies on (series-membership.service.ts, 3.0.0):
- a `seriesMemberships` list in a PATCH replaces the whole list; entry 0 becomes the primary and
  is mirrored into seriesName/seriesIndex as sent; a repeated name (lower-cased) is dropped;
- a scalar seriesName/seriesIndex write replaces the primary only and keeps the extras -- but a
  CLEARED series promotes the first extra to primary, and a series equal to an extra's name
  collapses the pair.
"""
import re

from app.bo_render import normalize_metadata_text

UMBRELLAS = {
    "The Cosmere": {
        # "Secret Projects" is deliberately no member: The Frugal Wizard's Handbook is not Cosmere
        "member_series": ("The Stormlight Archive", "The Mistborn Saga: The Original Trilogy",
                          "Mistborn: Wax & Wayne", "Mistborn: Ghostbloods", "Hoid's Travails",
                          "Warbreaker", "White Sand", "Elantris"),
        "aliases": ("Cosmere", "The Cosmere Universe", "The Cosmere Collection"),
    },
    "The Realm of the Elderlings": {
        "member_series": ("The Farseer Trilogy", "The Liveship Traders", "The Tawny Man",
                          "The Rain Wild Chronicles", "Fitz and the Fool", "Farseer Trilogy",
                          "Liveship Traders"),
        "aliases": ("Realm of the Elderlings", "The Realm of Elderlings", "Realm of Elderlings",
                    "The Elderlings"),
    },
    "First Law World": {
        "member_series": ("The First Law", "The Age of Madness"),
        "aliases": ("The First Law World",),
    },
    "The Mistborn Saga": {
        "member_series": ("The Mistborn Saga: The Original Trilogy", "Mistborn: Wax & Wayne",
                          "Mistborn: Ghostbloods"),
        "aliases": ("Mistborn", "Mistborn Saga"),
    },
}


def key(name) -> str:
    """BookOrbit's series identity (normalizeMetadataTextKey: normalizeMetadataText, lower-cased).
    '' for no name."""
    return (normalize_metadata_text(name) or "").lower() if isinstance(name, str) else ""


_TRAILING = re.compile(r"\s+(universe|collection|series)$")


def _alias_key(name) -> str:
    """key() without a leading "the " and a trailing "universe"/"collection"/"series", so that
    "Cosmere Universe" and "The Cosmere Collection" still name The Cosmere."""
    k = key(name)
    k = k[4:] if k.startswith("the ") else k
    return _TRAILING.sub("", k).strip()


_MEMBER_OF = {}
for _u, _spec in UMBRELLAS.items():
    for _s in _spec["member_series"]:
        _MEMBER_OF.setdefault(key(_s), []).append(_u)
_UMBRELLA_OF = {_alias_key(n): u for u, spec in UMBRELLAS.items() for n in (u, *spec["aliases"])}
_UMBRELLA_OF.pop("", None)


def umbrellas_for(series) -> list:
    """The umbrellas a book whose own series is `series` belongs to (Wax & Wayne: The Cosmere and
    The Mistborn Saga), in UMBRELLAS order."""
    return list(_MEMBER_OF.get(key(series), ()))


def as_umbrella(series) -> str | None:
    """The umbrella `series` names (itself, an alias or a close spelling of one), or None."""
    return _UMBRELLA_OF.get(_alias_key(series)) if key(series) not in _MEMBER_OF else None


def memberships(book: dict) -> list:
    """[(name, index)] of a GET /books/{id} detail, primary first."""
    ms = sorted(book.get("seriesMemberships") or [], key=lambda m: m.get("displayOrder") or 0)
    return [(m.get("seriesName"), m.get("seriesIndex")) for m in ms]


def series_change_problem(book: dict, series) -> str | None:
    """Why setting `series` as the primary of `book` (a GET detail; {} for a new book) needs a
    human, or None.

    - `series` is an umbrella (or an alias): it would name the folder, and on a book already in
      that umbrella the two memberships collapse into one -- the book's own series is lost;
    - the book's current primary IS an umbrella (Elantris: The Cosmere #1) and `series` is another
      series: the scalar write replaces that only membership, and the umbrella is gone;
    - the book has other memberships and `series` is not its current primary: a scalar series
      write keeps them, so e.g. The Cosmere would stay on a book moved to an unrelated series."""
    current = book.get("seriesName")
    if current and key(series) == key(current):
        return None                                   # the same series (an index fix)
    u = as_umbrella(series)
    if u:
        return (f"{series!r} is the umbrella series {u!r}: it is never a book's own series (that names "
                "the folder); use the book's specific series -- the umbrella is added as a second "
                "membership automatically. A book with no more specific series needs a human decision")
    if as_umbrella(current):
        return (f"book {book.get('id')}'s own series is the umbrella {current!r}: changing it would drop "
                "that membership -- a human decides that")
    extras = memberships(book)[1:]
    if extras:
        return (f"book {book.get('id')} is also in {', '.join(repr(n) for n, _i in extras)}: changing "
                "its series would leave that membership on it -- a human decides that")
    return None
