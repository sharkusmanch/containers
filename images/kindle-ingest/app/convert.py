"""EPUB conversion and structural comic classification.

Classification is deliberately structural, never log-scraping. calibre prints
"Format is fixed layout comic", but matching on a human-readable string from a
third-party tool fails silently when the wording changes -- and it fails OPEN,
turning every comic into a giant EPUB that an additive-only pipeline can never
replace.

Fixed-layout is also NOT the same as comic: cookbooks, textbooks and poetry are
pre-paginated but text-bearing, and converting one to CBZ would discard its text
irrecoverably. All three signals must agree, and anything borderline is routed
to a human instead of guessed.
"""
import os
import re
import subprocess
import zipfile
from dataclasses import dataclass, field

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp")
TEXT_CLEAR_MAX = 50      # below this, a page carries no real text
TEXT_AMBIGUOUS_MAX = 200  # between: cannot decide safely
IMAGE_PAGE_RATIO = 0.90   # fraction of spine pages that must be a single image

CLEAR, AMBIGUOUS = "clear", "ambiguous"


class ConvertFailed(Exception):
    pass


@dataclass
class Classification:
    is_comic: bool
    confidence: str
    reasons: list[str] = field(default_factory=list)
    spine_len: int = 0
    median_text: int = 0
    image_ratio: float = 0.0


def _strip_tags(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    return re.sub(r"<[^>]+>", " ", s)


def _opf_and_spine(z: zipfile.ZipFile):
    opf_name = next((n for n in z.namelist() if n.lower().endswith(".opf")), None)
    if not opf_name:
        raise ConvertFailed("no OPF in EPUB")
    opf = z.read(opf_name).decode("utf-8", "ignore")
    base = os.path.dirname(opf_name)
    ids = dict(re.findall(r'<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf))
    ids.update({i: h for h, i in re.findall(r'<item\b[^>]*href="([^"]+)"[^>]*id="([^"]+)"', opf)})
    spine = re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf)
    hrefs = []
    for ref in spine:
        h = ids.get(ref)
        if h:
            hrefs.append(os.path.normpath(os.path.join(base, h)).replace(os.sep, "/"))
    return opf, hrefs, base


def _page_signals(z, path):
    """Return (text_len, distinct_images, has_viewport) for one spine page."""
    try:
        raw = z.read(path).decode("utf-8", "ignore")
    except KeyError:
        return None
    imgs = {m for m in re.findall(r'(?:src|xlink:href)="([^"]+)"', raw)
            if m.lower().endswith(IMAGE_EXT)}
    has_viewport = bool(re.search(r'<meta[^>]+name="viewport"[^>]+width=\d+', raw))
    return len(_strip_tags(raw).strip()), len(imgs), has_viewport


def classify(epub_path: str) -> Classification:
    """Decide comic vs prose from structure, never from a tool's log output.

    Signals, measured on real books rather than assumed:
      * median extractable text per page -- the dominant signal. A real comic
        measures ~8 characters per page; real prose measures 6,000-28,000.
      * a per-page viewport meta with explicit pixel dimensions, which is how
        calibre expresses fixed layout for KFX comics. (Note: `rendition:layout`
        is NOT present in these files, so relying on it alone silently fails.)
      * fraction of pages carrying exactly one DISTINCT image. Distinct matters:
        Kindle Panel View emits the same image twice per page, once for the
        picture and once for the magnification anchor.

    Text alone is nearly decisive, but a corroborating structural signal is
    required so that a text-free art or poetry book is not silently shredded
    into a CBZ.
    """
    with zipfile.ZipFile(epub_path) as z:
        opf, pages, _ = _opf_and_spine(z)
        opf_pre_paginated = "pre-paginated" in opf
        texts, single_image_pages, viewport_pages = [], 0, 0
        for p in pages:
            sig = _page_signals(z, p)
            if sig is None:
                continue
            text_len, n_imgs, has_viewport = sig
            texts.append(text_len)
            if n_imgs == 1:
                single_image_pages += 1
            if has_viewport:
                viewport_pages += 1

    n = len(texts) or 1
    texts.sort()
    median = texts[len(texts) // 2]
    ratio = single_image_pages / n
    viewport_ratio = viewport_pages / n
    fixed_layout = opf_pre_paginated or viewport_ratio >= IMAGE_PAGE_RATIO

    reasons = [
        f"median_text={median}",
        f"image_ratio={ratio:.2f}",
        f"viewport_ratio={viewport_ratio:.2f}",
        f"opf_pre_paginated={opf_pre_paginated}",
        f"spine={n}",
    ]
    structural = fixed_layout and ratio >= IMAGE_PAGE_RATIO

    # Structure is decisive in the negative direction. A CBZ is a bag of page
    # images; a book without fixed layout and without one-image-per-page simply
    # cannot be one, whatever its text density. This matters because median text
    # is skewed low by front matter and part dividers -- a real novel measured 4
    # characters -- and treating that as "might be a comic" would flood the
    # human queue with obvious prose.
    if not structural:
        return Classification(False, CLEAR, reasons + ["not fixed-layout image pages"], n, median, ratio)
    if median < TEXT_CLEAR_MAX:
        return Classification(True, CLEAR, reasons, n, median, ratio)
    if median < TEXT_AMBIGUOUS_MAX:
        return Classification(False, AMBIGUOUS, reasons + ["fixed-layout, borderline text"], n, median, ratio)
    # Fixed-layout but genuinely text-bearing: a cookbook, textbook or poetry
    # collection. Must stay EPUB -- CBZ would discard its text irrecoverably.
    return Classification(False, CLEAR, reasons + ["fixed-layout but text-bearing"], n, median, ratio)


def epub_to_cbz(epub_path: str, out_path: str) -> int:
    """Extract page images in spine order into a CBZ. Returns page count."""
    with zipfile.ZipFile(epub_path) as z:
        _, pages, _ = _opf_and_spine(z)
        images, seen = [], set()
        for p in pages:
            try:
                raw = z.read(p).decode("utf-8", "ignore")
            except KeyError:
                continue
            for m in re.findall(r'(?:src|xlink:href)="([^"]+)"', raw):
                if not m.lower().endswith(IMAGE_EXT):
                    continue
                ip = os.path.normpath(os.path.join(os.path.dirname(p), m)).replace(os.sep, "/")
                if ip in z.namelist() and ip not in seen:
                    seen.add(ip)
                    images.append(ip)
        if not images:
            raise ConvertFailed(f"no page images found in {epub_path}")
        if len(images) != len(pages):
            raise ConvertFailed(
                f"page/spine mismatch: {len(images)} images vs {len(pages)} spine items")
        tmp = out_path + ".part"
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as out:
            for i, ip in enumerate(images, 1):
                out.writestr(f"{i:04d}{os.path.splitext(ip)[1].lower()}", z.read(ip))
    os.replace(tmp, out_path)
    return len(images)


def to_epub(src: str, out_path: str, timeout: int, binary: str = "ebook-convert") -> str:
    """Convert to EPUB, returning calibre's output.

    The log is returned rather than discarded so the caller can compare
    calibre's own verdict against the structural classifier and count
    disagreements -- the only way to notice calibre changing its wording.
    Written temp+rename so a killed conversion cannot leave a complete-looking
    file that skip-if-exists would then trust forever.
    """
    tmp = out_path + ".part.epub"
    p = subprocess.run([binary, src, tmp], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0 or not os.path.exists(tmp):
        raise ConvertFailed((p.stderr or p.stdout or "")[-400:])
    os.replace(tmp, out_path)
    return (p.stdout or "") + (p.stderr or "")
