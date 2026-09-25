"""Umbrella series: a series that spans other series (2026-09-24).

A BookOrbit book can belong to several series. The first membership (display order 0) is the
primary: BookOrbit mirrors it into seriesName/seriesIndex and names the folder after it. Every
further membership is an extra that never moves a file. An umbrella (The Cosmere, The Realm of the
Elderlings) is always an extra, so a book keeps its own series -- The Stormlight Archive #1 plus
The Cosmere #6 -- and is never filed under the umbrella's name.

Mirror of the books repo's scripts/bookorbit/umbrella.py (which also carries the audit's exception
lists): keep the member series and aliases of both in step. Positions come from Goodreads there,
by hand; a new filing gets the umbrella WITHOUT a position (never invented) and the audit asks for it.

BookOrbit semantics this relies on (series-membership.service.ts, 3.0.0):
- a `seriesMemberships` list in a PATCH replaces the whole list; entry 0 becomes the primary and
  is mirrored into seriesName/seriesIndex as sent; a repeated name (lower-cased) is dropped;
- a scalar seriesName/seriesIndex write replaces the primary only and keeps the extras -- but a
  CLEARED series promotes the first extra to primary, and a series equal to an extra's name
  collapses the pair.
"""
import re

UMBRELLAS = {
    "The Cosmere": {
        "member_series": ("The Stormlight Archive", "The Mistborn Saga: The Original Trilogy",
                          "Mistborn: Wax & Wayne", "Mistborn", "Hoid's Travails", "Warbreaker",
                          "White Sand", "Elantris"),
        "aliases": ("Cosmere", "The Cosmere Universe"),
    },
    "The Realm of the Elderlings": {
        "member_series": ("The Farseer Trilogy", "The Liveship Traders", "The Tawny Man",
                          "The Rain Wild Chronicles", "Fitz and the Fool"),
        "aliases": ("Realm of the Elderlings", "The Realm of Elderlings", "Realm of Elderlings"),
    },
}
# "Secret Projects" is deliberately no member series: The Frugal Wizard's Handbook is not Cosmere.


def key(name) -> str:
    """BookOrbit's series identity (normalizeMetadataTextKey): whitespace collapsed, trimmed,
    lower-cased. '' for no name."""
    return re.sub(r"\s+", " ", name if isinstance(name, str) else "").strip().lower()


_MEMBER_OF = {key(s): u for u, spec in UMBRELLAS.items() for s in spec["member_series"]}
_UMBRELLA_OF = {key(n): u for u, spec in UMBRELLAS.items() for n in (u, *spec["aliases"])}


def umbrella_for(series) -> str | None:
    """The umbrella a book whose own series is `series` belongs to, or None."""
    return _MEMBER_OF.get(key(series))


def as_umbrella(series) -> str | None:
    """The umbrella `series` names (itself or an alias), or None."""
    return _UMBRELLA_OF.get(key(series))


def memberships(book: dict) -> list:
    """[(name, index)] of a GET /books/{id} detail, primary first."""
    ms = sorted(book.get("seriesMemberships") or [], key=lambda m: m.get("displayOrder") or 0)
    return [(m.get("seriesName"), m.get("seriesIndex")) for m in ms]


def series_change_problem(book: dict, series) -> str | None:
    """Why setting `series` as the primary of `book` (a GET detail) needs a human, or None.

    - `series` is an umbrella (or an alias): it would name the folder, and on a book already in
      that umbrella the two memberships collapse into one -- the book's own series is lost;
    - the book has other memberships and `series` is not its current primary: a scalar series
      write keeps them, so e.g. The Cosmere would stay on a book moved to an unrelated series."""
    u = as_umbrella(series)
    if u:
        return (f"{series!r} is the umbrella series {u!r}: it is never a book's own series (that names "
                "the folder); use the book's specific series -- the umbrella is added as a second "
                "membership automatically. A book with no more specific series needs a human decision")
    extras = memberships(book)[1:]
    if extras and key(series) != key(book.get("seriesName")):
        return (f"book {book.get('id')} is also in {', '.join(repr(n) for n, _i in extras)}: changing "
                "its series would leave that membership on it -- a human decides that")
    return None
