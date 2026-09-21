"""Orchestration: one book at a time, refuse rather than degrade, atomic publish."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from app import VERSION, anchors, audio, epubwrite, repair, segment, textmap, timing, verify
from app.absclient import ABSClient
from app.bbsource import BookBridgeDB, BookRow, resolve_epub

G5_TOLERANCE_S = 0.25
MIN_COVERAGE = 0.99
# Only outcomes that did real export work count against MAX_BOOKS_PER_RUN, so books that
# defer or error every run cannot starve the rest of the queue.
WORK_STATUSES = ("ok", "refused")


def _code_sha256() -> str:
    """Hash of this package's own source, so any code change re-triggers every book (a fix to a
    refusal cause would otherwise never be retried while VERSION stays the same)."""
    h = hashlib.sha256()
    for p in sorted(Path(__file__).parent.glob("*.py")):
        h.update(p.name.encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


CODE_SHA256 = _code_sha256()


class ConfigError(Exception):
    pass


def _endpoints(v: str) -> list[tuple[str, str]]:
    out = []
    for x in v.split(","):
        if not x.strip():
            continue
        url, sep, model = (y.strip() for y in x.partition("|"))
        if not sep or not url or not model:
            raise ConfigError(f"WHISPER_ENDPOINTS entry {x.strip()!r} is not url|model")
        out.append((url, model))
    return out


def _max_books(v: str) -> int:
    try:
        n = int(v.strip())
    except ValueError:
        raise ConfigError(f"MAX_BOOKS_PER_RUN must be a non-negative integer, got {v!r}") from None
    if n < 0:
        raise ConfigError(f"MAX_BOOKS_PER_RUN must be a non-negative integer, got {v!r}")
    return n


@dataclass
class Config:
    db_path: str = "/data/database.db"
    books_roots: list[str] = field(default_factory=lambda: ["/books", "/data/epub_cache"])
    out_dir: str = "/out"
    tmp_dir: str = "/tmp"
    whisper: list[tuple[str, str]] = field(default_factory=list)
    only: set[str] | None = None
    max_books: int = 3
    bitrate: str = "32k"
    path_map: list[tuple[str, str]] = field(default_factory=list)

    @classmethod
    def from_env(cls, env) -> "Config":
        def pairs(v, sep):
            return [tuple(x.split(sep, 1)) for x in v.split(",") if x.strip()] if v else []
        only = {x.strip() for x in env.get("EXPORT_ONLY_ABS_IDS", "").split(",") if x.strip()} or None
        return cls(db_path=env.get("DB_PATH", "/data/database.db"),
                   books_roots=[x for x in env.get("BOOKS_ROOTS", "/books:/data/epub_cache").split(":") if x],
                   out_dir=env.get("OUT_DIR", "/out"), tmp_dir=env.get("TMPDIR", "/tmp"),
                   whisper=_endpoints(env.get("WHISPER_ENDPOINTS", "")), only=only,
                   max_books=_max_books(env.get("MAX_BOOKS_PER_RUN", "3")), bitrate=env.get("BITRATE", "32k"),
                   path_map=pairs(env.get("PATH_MAP", ""), "="))


@dataclass
class Outcome:
    abs_id: str
    title: str
    status: str
    reason: str = ""
    detail: dict = field(default_factory=dict)


class Refuse(Exception):
    def __init__(self, reason, detail=""):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


class Defer(Exception):
    def __init__(self, reason, detail=""):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


def _sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _map_path(p: str, path_map) -> str:
    for src, dst in path_map:
        if p.startswith(src):
            return dst + p[len(src):]
    return p


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    os.replace(tmp, path)


def _is_fixed_layout(epub_path) -> bool:
    """Book-wide fixed layout only: a package-level `<meta property="rendition:layout">` of
    `pre-paginated` (no `refines`). A per-item spine override
    (`properties="rendition:layout-pre-paginated"`) in a reflowable book does not count."""
    import zipfile

    from lxml import etree
    with zipfile.ZipFile(epub_path) as z:
        root = etree.fromstring(z.read(textmap.opf_path(z)), etree.XMLParser(recover=True))
    if root is None:
        return False
    local = etree.QName
    for md in root:
        if not isinstance(md.tag, str) or local(md).localname != "metadata":
            continue
        for el in md:
            if (isinstance(el.tag, str) and local(el).localname == "meta" and el.get("refines") is None
                    and (el.get("property") or "").strip() == "rendition:layout"
                    and (el.text or "").strip() == "pre-paginated"):
                return True
    return False


def _error(row: BookRow, e: BaseException, detail: dict | None = None) -> Outcome:
    return Outcome(row.abs_id, row.title, "error", type(e).__name__, {**(detail or {}), "error": str(e)[:500]})


def _read_manifest(path: Path) -> dict | None:
    """Previous manifest, or None when absent, unreadable or not a JSON object."""
    try:
        prev = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return prev if isinstance(prev, dict) else None


def process_book(row: BookRow, cfg: Config, abs_client, whisper_client, now: str,
                 load_map: Callable[[str], str] | None = None) -> Outcome:
    """Never raises: any unexpected failure (incl. fingerprinting/manifest I/O) is an `error` outcome.
    `load_map(abs_id)` supplies the alignment map JSON lazily; without it `row.map_json` is used."""
    try:
        return _process_book(row, cfg, abs_client, whisper_client, now, load_map)
    except Exception as e:  # noqa: BLE001 - one bad book must not stop the run
        return _error(row, e)


def _process_book(row: BookRow, cfg: Config, abs_client, whisper_client, now: str,
                  load_map: Callable[[str], str] | None = None) -> Outcome:
    try:
        item = abs_client.item(row.abs_id)
    except Exception as e:  # noqa: BLE001
        return Outcome(row.abs_id, row.title, "deferred", "abs_unavailable", {"error": str(e)})
    folder = Path(cfg.out_dir) / Path(item.folder).name
    epub_path = resolve_epub(row.ebook_filename, cfg.books_roots)
    stem = Path(row.ebook_filename).stem
    manifest_path = folder / f".{stem}.readaloud.json"
    target = folder / f"{stem} (readaloud).epub"
    m4b = Path(_map_path(item.audio_path, cfg.path_map))

    fp_src = {"version": VERSION, "code_sha256": CODE_SHA256,
              "last_updated": row.last_updated, "bitrate": cfg.bitrate,
              "epub_sha256": _sha256(epub_path) if epub_path else None,
              "m4b": [str(m4b), m4b.stat().st_size, int(m4b.stat().st_mtime)] if m4b.exists() else None}
    fingerprint = hashlib.sha256(json.dumps(fp_src, sort_keys=True).encode()).hexdigest()
    prev = _read_manifest(manifest_path)
    if prev and prev.get("fingerprint") == fingerprint and (
            prev.get("status") == "refused" or (prev.get("status") == "ok" and target.exists())):
        return Outcome(row.abs_id, row.title, "skipped", prev.get("reason", ""))

    work = Path(tempfile.mkdtemp(prefix=f"ra-{row.abs_id[:8]}-", dir=cfg.tmp_dir))
    detail: dict = {"fingerprint_inputs": fp_src}
    part: Path | None = None
    try:
        if item.n_files != 1:
            raise Refuse("multi_file_audio", f"{item.n_files} files")
        if epub_path is None:
            raise Refuse("epub_not_found", row.ebook_filename)
        if not m4b.exists():
            raise Refuse("audio_not_found", str(m4b))
        if _is_fixed_layout(epub_path):
            raise Refuse("fixed_layout")
        try:
            docs = textmap.build(epub_path, total_chars=row.total_chars)
        except textmap.TextMapError as e:
            raise Refuse(e.reason, e.detail) from e
        ref = textmap.reference_string([(d.href, d.ref_text) for d in docs])
        raw_map = json.loads(load_map(row.abs_id) if load_map is not None else row.map_json)
        try:
            anc = anchors.clean(raw_map)
            rate = anchors.book_rate(anc)
        except anchors.AnchorError as e:
            raise Refuse(e.reason, str(e)) from e
        del raw_map
        gaps = anchors.gaps(anc, row.total_chars, item.duration, rate)
        holes = [g for g in gaps if g.kind == "hole"]
        audio_only = [g for g in gaps if g.kind == "audio_only"]
        detail.update(book_rate=round(rate, 2), holes=len(holes),
                      hole_seconds=round(sum(g.dts for g in holes), 1),
                      audio_only_gaps=len(audio_only),
                      audio_only_seconds=round(sum(g.dts for g in audio_only), 1),
                      audio_only_max_s=round(max((g.dts for g in audio_only), default=0.0), 1))

        # Holes (narrated text with no anchor) and audio-only stretches (long audio, little text)
        # are both re-transcribed; only holes left after repair fail G3.
        targets = sorted(holes + audio_only, key=lambda g: g.c_a)
        repaired = 0
        if targets:
            cache = folder / ".cache" / row.abs_id
            cache.mkdir(parents=True, exist_ok=True)

            def transcribe_range(s: float, e: float):
                key = cache / f"{round(s * 1000)}-{round(e * 1000)}.json"
                if key.exists():
                    return [repair.Word(**w) for w in json.loads(key.read_text())["words"]]
                wav = work / f"{round(s * 1000)}-{round(e * 1000)}.wav"
                audio.cut_wav(m4b, s, e, wav)
                try:
                    words, model = whisper_client.transcribe(wav)
                except repair.WhisperUnavailable as ex:
                    raise Defer("whisper_unavailable", str(ex)) from ex
                finally:
                    wav.unlink(missing_ok=True)
                absw = [repair.Word(w.text, w.start + s, w.end + s) for w in words]
                _write_json_atomic(key, {"model": model, "words": [asdict(w) for w in absw]})
                return absw

            extra = []
            for g in targets:
                extra.extend(repair.repair_hole(g, ref, transcribe_range))
            repaired = len(extra)
            anc = anchors.merge(anc, extra)
            gaps = anchors.gaps(anc, row.total_chars, item.duration, rate)
            left = [g for g in gaps if g.kind == "hole"]
            detail.update(repaired_anchors=repaired, residual_holes=len(left),
                          residual_max_hole_s=round(max((g.dts for g in left), default=0.0), 1),
                          residual_audio_only=sum(g.kind == "audio_only" for g in gaps))
            if left:
                raise Refuse("unrepaired_hole", f"{len(left)} holes, max {max(g.dts for g in left):.0f}s")
        detail["repaired_anchors"] = repaired
        detail["residual_audio_only"] = sum(g.kind == "audio_only" for g in gaps)

        frags = [f for d in docs for f in segment.fragments(d)]
        narr = timing.narrated(frags, gaps)
        t = timing.interpolator(anc, rate, item.duration)
        try:
            pars = timing.tile(narr, t, item.duration)
        except timing.TimingError as e:
            raise Refuse(e.reason, str(e)) from e
        cov = timing.coverage(narr, pars)
        detail.update(fragments=len(frags), narrated_fragments=len(narr), pars=len(pars), coverage=round(cov, 5),
                      max_par_s=round(max(p.end - p.begin for p in pars) / 1000, 1))
        if cov < MIN_COVERAGE:
            raise Refuse("low_coverage", f"{cov:.4f}")
        have = {p.frag_id for p in pars}
        by_doc: dict[int, list] = {}
        for f in frags:
            if f.id in have:
                by_doc.setdefault(f.doc_index, []).append(f)
        try:
            for d in docs:
                segment.wrap(d, by_doc.get(d.index, []))
        except textmap.TextMapError as e:
            raise Refuse(e.reason, e.detail) from e

        files = timing.cut_plan(pars, item.chapter_starts)
        audio_paths = {}
        for f in files:
            p = work / f.name
            try:
                audio.encode_opus(m4b, f.start, f.end, p, cfg.bitrate)
                got = audio.probe_duration(p)
            except audio.AudioError as e:
                raise Refuse("audio_encode_failed", str(e)) from e
            if abs(got - (f.end - f.start) / 1000) > G5_TOLERANCE_S:
                raise Refuse("audio_cut_mismatch", f"{f.name}: {got:.3f}s vs {(f.end - f.start) / 1000:.3f}s")
            audio_paths[f.name] = p
        detail["audio_files"] = len(files)

        folder.mkdir(parents=True, exist_ok=True)
        part = folder / f".{stem} (readaloud).epub.part"
        try:
            epubwrite.write_readaloud(epub_path, part, docs, pars, files, audio_paths, now)
        except (ValueError, KeyError, AttributeError) as e:
            # manifest collision, malformed NCX, missing NCX/manifest entry: deterministic
            raise Refuse("epub_structure", f"{type(e).__name__}: {e}") from e
        vr = verify.verify(epub_path, part, item.duration)
        detail["verify"] = {"ok": vr.ok, "failures": vr.failures[:20], "overlay_seconds": vr.overlay_seconds}
        if not vr.ok:
            part.unlink(missing_ok=True)
            raise Refuse("verify_failed", "; ".join(vr.failures[:5]))
        os.replace(part, target)
        detail["size_bytes"] = target.stat().st_size
        out = Outcome(row.abs_id, row.title, "ok", "", detail)
    except Refuse as r:
        out = Outcome(row.abs_id, row.title, "refused", r.reason, {**detail, "error": str(r.detail)})
    except Defer as d:
        return Outcome(row.abs_id, row.title, "deferred", d.reason, {**detail, "error": str(d.detail)})
    except Exception as e:  # noqa: BLE001 - one bad book must not stop the run
        return Outcome(row.abs_id, row.title, "error", type(e).__name__, {**detail, "error": str(e)[:500]})
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if part is not None:
            part.unlink(missing_ok=True)  # published by os.replace, or abandoned
    folder.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(manifest_path, {"fingerprint": fingerprint, "status": out.status, "reason": out.reason,
                                       "exporter_version": VERSION, "code_sha256": CODE_SHA256,
                                       "abs_id": row.abs_id, "title": row.title,
                                       "align_method": row.align_method, "written_at": now, **out.detail})
    return out


def run(cfg: Config, db: BookBridgeDB, abs_client, whisper_client) -> list[Outcome]:
    outcomes, worked = [], 0
    for row in db.eligible(cfg.only):
        if worked >= cfg.max_books:
            break
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        t0 = time.monotonic()
        try:
            o = process_book(row, cfg, abs_client, whisper_client, now, load_map=db.map_json)
        except Exception as e:  # noqa: BLE001 - belt and braces: one book never stops the run
            o = _error(row, e)
        o.detail["seconds"] = round(time.monotonic() - t0, 1)
        if o.status in WORK_STATUSES:
            worked += 1
        print(json.dumps({"event": "book", **asdict(o)}, default=str), flush=True)
        outcomes.append(o)
    summary = {}
    for o in outcomes:
        summary[o.status] = summary.get(o.status, 0) + 1
    print(json.dumps({"event": "summary", "version": VERSION, **summary}), flush=True)
    return outcomes


def main() -> int:
    try:
        cfg = Config.from_env(os.environ)
        print(json.dumps({"event": "config", "version": VERSION, "code_sha256": CODE_SHA256,
                          "whisper_endpoints": [f"{u}|{m}" for u, m in cfg.whisper],
                          "only_count": None if cfg.only is None else len(cfg.only),
                          "max_books": cfg.max_books, "out_dir": cfg.out_dir}), flush=True)
        if not Path(cfg.db_path).exists():
            raise ConfigError(f"missing {cfg.db_path}")
    except ConfigError as e:
        print(json.dumps({"event": "config_error", "error": str(e)}), flush=True)
        return 2
    db = BookBridgeDB(cfg.db_path)
    s = db.settings()
    abs_client = ABSClient(s.get("ABS_SERVER", ""), s.get("ABS_KEY", ""))
    whisper_client = repair.WhisperClient(cfg.whisper)
    try:
        run(cfg, db, abs_client, whisper_client)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
