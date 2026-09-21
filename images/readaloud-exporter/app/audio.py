"""ffmpeg/ffprobe wrappers. Only the first audio stream is used: these m4b
files also carry a cover image and a chapter data stream."""
from __future__ import annotations

import shutil
import subprocess


class AudioError(Exception):
    pass


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise AudioError(f"{cmd[0]} failed ({p.returncode}): {p.stderr.strip()[-500:]}")
    return p.stdout


def encode_opus(src, start_ms: int, end_ms: int, dst, bitrate: str = "32k") -> None:
    _run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y",
          "-ss", f"{start_ms / 1000:.3f}", "-to", f"{end_ms / 1000:.3f}", "-i", str(src),
          "-vn", "-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
          "-ac", "1", "-c:a", "libopus", "-b:a", bitrate, "-f", "mp4", str(dst)])


def cut_wav(src, start_s: float, end_s: float, dst) -> None:
    _run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y",
          "-ss", f"{start_s:.3f}", "-to", f"{end_s:.3f}", "-i", str(src),
          "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", str(dst)])


def probe_duration(path) -> float:
    out = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", str(path)]).strip()
    try:
        return float(out)
    except ValueError as e:
        raise AudioError(f"no duration for {path}: {out!r}") from e
