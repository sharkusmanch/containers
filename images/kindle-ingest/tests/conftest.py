import os
import zipfile
import pytest


def make_epub(path, spine, text_per_page, viewport=False, images_per_page=1,
              duplicate_image_ref=False, pre_paginated=False):
    """Build a minimal EPUB with controllable structural signals."""
    manifest, itemrefs, pages = [], [], {}
    for i in range(spine):
        pid, href = f"p{i}", f"OEBPS/p{i}.xhtml"
        manifest.append(f'<item id="{pid}" href="p{i}.xhtml" media-type="application/xhtml+xml"/>')
        itemrefs.append(f'<itemref idref="{pid}"/>')
        vp = '<meta name="viewport" content="width=1988, height=3056"/>' if viewport else ""
        img = ""
        for j in range(images_per_page):
            img += f'<img src="img{i}_{j}.jpg"/>'
            if duplicate_image_ref:
                img += f'<a href="#z"><img src="img{i}_{j}.jpg"/></a>'
        pages[href] = f"<html><head>{vp}</head><body>{img}<p>{'w' * text_per_page}</p></body></html>"
    rendition = ' rendition:layout="pre-paginated"' if pre_paginated else ""
    opf = (f'<package{rendition}><manifest>{"".join(manifest)}'
           f'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>'
           f'<spine>{"".join(itemrefs)}</spine></package>')
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("OEBPS/content.opf", opf)
        for href, body in pages.items():
            z.writestr(href, body)
        for i in range(spine):
            for j in range(images_per_page):
                z.writestr(f"OEBPS/img{i}_{j}.jpg", b"\xff\xd8\xff" + bytes(20))
    return str(path)


@pytest.fixture
def epub_factory(tmp_path):
    def _f(name="b.epub", **kw):
        return make_epub(tmp_path / name, **kw)
    return _f
