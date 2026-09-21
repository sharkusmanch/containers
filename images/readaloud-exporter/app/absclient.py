"""Audiobookshelf item lookup: audio file path, duration, chapter starts."""
from __future__ import annotations

from dataclasses import dataclass

import requests


@dataclass
class AudioItem:
    folder: str
    audio_path: str
    duration: float
    chapter_starts: list[float]
    n_files: int


class ABSClient:
    def __init__(self, base: str, token: str, session=None, timeout=30):
        self.base, self.token = base.rstrip("/"), token
        self.session = session or requests.Session()
        self.timeout = timeout

    def item(self, item_id: str) -> AudioItem:
        r = self.session.get(f"{self.base}/api/items/{item_id}", params={"expanded": 1},
                             headers={"Authorization": f"Bearer {self.token}"}, timeout=self.timeout)
        r.raise_for_status()
        j = r.json()
        media = j["media"]
        files = media.get("audioFiles") or []
        return AudioItem(folder=j["path"],
                         audio_path=files[0]["metadata"]["path"] if files else "",
                         duration=float(media["duration"]),
                         chapter_starts=[float(c["start"]) for c in media.get("chapters") or []],
                         n_files=len(files))
