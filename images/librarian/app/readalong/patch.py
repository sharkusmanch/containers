"""Rewrite zero-length SMIL <audio> clips in place so BookOrbit's progress-sync
bridge (findItemBySeconds) stops treating them as "unknown end" and matching
every later audio position against the first one it finds — see smil.py's
module docstring for the underlying bug and gate.py for the refusal this
patch exists to clear.

Only the `<n>s` timecount clock form is rewritten (that is the only form
Storyteller v3 emits); any other clock form found in a .smil after patching
raises ValueError rather than silently leaving it unpatched.
"""
import io
import os
import re
import zipfile

FLUSH_EVERY = 64 << 20


class _FlushingFile(io.FileIO):
    """vendored + (2026-09-23): the patched copy is written to NFS, whose dirty
    pages count against the pod's memory limit -- fsync and drop them every
    FLUSH_EVERY bytes, as the download does."""

    def __init__(self, path, flush_every=None):
        super().__init__(path, "w")
        self._since, self._every = 0, flush_every or FLUSH_EVERY

    def write(self, b):
        n = super().write(b)
        self._since += n or 0
        if self._since >= self._every:
            os.fsync(self.fileno())
            os.posix_fadvise(self.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            self._since = 0
        return n

    def close(self):
        if not self.closed:
            os.fsync(self.fileno())
        super().close()

# clipBegin="12.500s" clipEnd="12.500s" (or any clipEnd <= clipBegin)
_CLIP_PAIR = re.compile(r'clipBegin="(\d+(?:\.\d+)?)s"\s+clipEnd="(\d+(?:\.\d+)?)s"')
# Any clipBegin/clipEnd whose value is not the plain "<n>s" timecount form.
_NON_TIMECOUNT_CLIP = re.compile(r'clip(?:Begin|End)="(?!\d+(?:\.\d+)?s")[^"]*"')


def patch_zero_length_clips(src_path, dst_path, epsilon=0.001):
    """Copy the EPUB at src_path to dst_path, rewriting every zero-length
    (clipEnd <= clipBegin) <audio> clip in every .smil entry to
    clipEnd = clipBegin + epsilon. Returns the number of clips patched.

    mimetype is written first and STORED (uncompressed), per the EPUB OCF
    spec. Every other entry is copied with its original compress_type — audio
    entries are large and stored, and must never be recompressed. Non-.smil
    entries are copied byte-for-byte.
    """
    patched = 0
    with zipfile.ZipFile(src_path) as src, _FlushingFile(dst_path) as out, zipfile.ZipFile(out, "w") as dst:
        names = src.namelist()

        mimetype_info = src.getinfo("mimetype") if "mimetype" in names else None
        if mimetype_info is not None:
            dst.writestr(zipfile.ZipInfo("mimetype"), src.read("mimetype"), compress_type=zipfile.ZIP_STORED)

        for info in src.infolist():
            if info.filename == "mimetype":
                continue
            data = src.read(info.filename)
            if info.filename.lower().endswith(".smil"):
                text = data.decode("utf-8")

                def _rewrite(m):
                    nonlocal patched
                    begin_text, end_text = m.group(1), m.group(2)
                    begin, end = float(begin_text), float(end_text)
                    if end <= begin:
                        patched += 1
                        return f'clipBegin="{begin_text}s" clipEnd="{begin + epsilon:.3f}s"'
                    return m.group(0)

                text = _CLIP_PAIR.sub(_rewrite, text)
                if _NON_TIMECOUNT_CLIP.search(text):
                    raise ValueError(
                        f"{info.filename}: clipBegin/clipEnd in a non-timecount clock form — "
                        "patch_zero_length_clips only handles the plain \"<n>s\" form")
                data = text.encode("utf-8")
            dst.writestr(info, data, compress_type=info.compress_type)
    return patched
