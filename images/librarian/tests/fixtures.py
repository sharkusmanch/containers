"""Test-only helper: build a minimal, valid EPUB on disk for app.media tests.

Kept deliberately compact (no incidental whitespace between tags) so tests
asserting on exact/ranged char_count aren't at the mercy of formatting.
"""
import zipfile
from xml.sax.saxutils import escape

_CONTAINER_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    "<rootfiles>"
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    "</rootfiles>"
    "</container>"
)


def make_epub(path, title, creators, text, date="2020", identifiers=None, raw_identifiers=None,
              description=None, dates=None):
    """`identifiers`: dict of scheme -> value, written with an `opf:scheme`
    attribute (the common case). `raw_identifiers`: list of (id, value) pairs
    written WITHOUT an `opf:scheme` attribute (id may be None) -- for
    exercising EPUB2's optional-scheme / urn: / bare-ISBN fallback paths.
    `description`: optional dc:description text (evals use it for injection).
    `dates`: optional list of (opf:event or None, value) written as dc:date
    elements in that order, instead of the single `date`."""
    identifiers = identifiers or {}
    raw_identifiers = raw_identifiers or []
    if dates is None:
        dates = [(None, date)]
    date_xml = "".join(
        (f'<dc:date opf:event="{escape(event)}">' if event else "<dc:date>") + f"{escape(value)}</dc:date>"
        for event, value in dates
    )

    creator_xml = "".join(f"<dc:creator>{escape(c)}</dc:creator>" for c in creators)
    identifier_xml = "".join(
        f'<dc:identifier opf:scheme="{escape(str(scheme).upper())}">{escape(str(value))}</dc:identifier>'
        for scheme, value in identifiers.items()
    )
    raw_identifier_xml = "".join(
        (f'<dc:identifier id="{escape(str(ident_id))}">' if ident_id else "<dc:identifier>")
        + f"{escape(str(value))}</dc:identifier>"
        for ident_id, value in raw_identifiers
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">'
        f"<dc:title>{escape(title)}</dc:title>"
        f"{creator_xml}"
        f"{date_xml}"
        "<dc:language>en</dc:language>"
        f"{'<dc:description>' + escape(description) + '</dc:description>' if description else ''}"
        f"{identifier_xml}"
        f"{raw_identifier_xml}"
        "</metadata>"
        "<manifest>"
        '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
        "</manifest>"
        "<spine>"
        '<itemref idref="c1"/>'
        "</spine>"
        "</package>"
    )
    xhtml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml">'
        "<body>"
        f"<p>{escape(text)}</p>"
        "</body>"
        "</html>"
    )

    with zipfile.ZipFile(path, "w") as zf:
        mimetype_info = zipfile.ZipInfo("mimetype")
        mimetype_info.compress_type = zipfile.ZIP_STORED
        zf.writestr(mimetype_info, "application/epub+zip")
        zf.writestr("META-INF/container.xml", _CONTAINER_XML)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/c1.xhtml", xhtml)
