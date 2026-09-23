"""Rewrite zero-length SMIL <audio> clips in place so BookOrbit's progress-sync
bridge (findItemBySeconds) stops treating them as "unknown end" and matching
every later audio position against the first one it finds — see smil.py's
module docstring for the underlying bug and gate.py for the refusal this
patch exists to clear.

Only the `<n>s` timecount clock form is rewritten (that is the only form
Storyteller v3 emits); any other clock form found in a .smil after patching
raises ValueError rather than silently leaving it unpatched.
"""
import re
import zipfile

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
    with zipfile.ZipFile(src_path) as src, zipfile.ZipFile(dst_path, "w") as dst:
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
