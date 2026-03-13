# Download Retry & Validation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add retry logic, post-download validation, fragment cleanup, and a per-run download budget to the RSS YouTube downloader so failed/incomplete downloads are detected and retried.

**Architecture:** Three new single-responsibility functions (`validate_download`, `cleanup_fragments`, `download_with_retry`) composed by a thin orchestrator. Existing `download_video()` unchanged. `process_feed()` modified to only record successful downloads in state and respect a global download budget. No new dependencies.

**Tech Stack:** Python 3.12, ffprobe (already in container via ffmpeg), stdlib glob/time

**Spec:** `docs/superpowers/specs/2026-03-12-download-retry-validation-design.md`

---

## File Structure

All changes are in a single file:

- **Modify:** `downloader.py` — add 3 new functions, modify `load_config`, `process_feed`, and `main`

No new files, no Dockerfile changes, no new dependencies.

---

## Chunk 1: New Functions

### Task 1: Add imports and constants

**Files:**
- Modify: `downloader.py:11-20` (imports)
- Modify: `downloader.py:53` (constants)

- [ ] **Step 1: Add `time` and `glob` imports**

At `downloader.py:11`, add `glob` and `time` to the existing stdlib imports. The imports section should become:

```python
import calendar
import glob
import html
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import URLError
from xml.etree.ElementTree import Element, SubElement, tostring
```

- [ ] **Step 2: Add fragment pattern constant**

After `DOWNLOAD_TIMEOUT = 1800` (line 53), add:

```python
FRAGMENT_SUFFIX_RE = re.compile(r"\.(part|temp\..+|f\d+\..+)$")
```

This matches yt-dlp artifact suffixes: `.part`, `.temp.*`, `.f<digits>.*` — anchored to the suffix portion extracted after the filename base.

- [ ] **Step 3: Commit**

```bash
git add downloader.py
git commit -m "chore: add imports and constants for retry/validation"
```

---

### Task 2: Implement `validate_download()`

**Files:**
- Modify: `downloader.py` — insert after `download_video()` function (after line 350)

- [ ] **Step 1: Add `validate_download` function**

Insert after the `download_video()` function (after line 350), before the Pruning section:

```python
def validate_download(filepath: str, format_string: str) -> tuple[bool, str | None]:
    """Validate a downloaded file has the expected streams.

    Checks file exists, is non-zero, and uses ffprobe to verify audio/video
    streams match what the format string requested.

    Returns (True, None) on success or (False, reason) on failure.
    """
    p = Path(filepath)
    if not p.exists() or p.stat().st_size == 0:
        return False, "file missing or empty"

    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=codec_type",
        "-of", "json",
        filepath,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return False, "ffprobe timed out"
    except OSError as exc:
        return False, f"ffprobe error: {exc}"

    if result.returncode != 0:
        return False, f"ffprobe failed: {result.stderr.strip()}"

    try:
        probe_data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False, "ffprobe returned invalid JSON"

    stream_types = [s.get("codec_type") for s in probe_data.get("streams", [])]

    expects_video = "video" in format_string
    has_video = "video" in stream_types
    has_audio = "audio" in stream_types

    if expects_video and not has_video:
        return False, f"missing video stream (got: {stream_types})"
    if expects_video and not has_audio:
        return False, f"missing audio stream (got: {stream_types})"
    if not expects_video and not has_audio:
        return False, f"missing audio stream (got: {stream_types})"

    return True, None
```

- [ ] **Step 2: Commit**

```bash
git add downloader.py
git commit -m "feat: add validate_download() for post-download stream verification"
```

---

### Task 3: Implement `cleanup_fragments()`

**Files:**
- Modify: `downloader.py` — insert after `validate_download()`

- [ ] **Step 1: Add `cleanup_fragments` function**

Insert immediately after `validate_download()`:

```python
def cleanup_fragments(output_dir: str, filename_base: str) -> None:
    """Remove leftover yt-dlp artifacts for a specific episode.

    Deletes .part files, .temp.* files, and unmerged stream fragments
    (.f<digits>.*) scoped to the given filename base.
    """
    pattern = os.path.join(output_dir, f"{filename_base}.*")
    base_prefix = os.path.join(output_dir, filename_base)

    for candidate in glob.glob(pattern):
        # Extract suffix after the filename base
        suffix = candidate[len(base_prefix):]
        if FRAGMENT_SUFFIX_RE.match(suffix):
            try:
                os.remove(candidate)
                log.info("Cleaned up fragment: %s", candidate)
            except OSError:
                pass  # Silently ignore missing/permission errors
```

- [ ] **Step 2: Commit**

```bash
git add downloader.py
git commit -m "feat: add cleanup_fragments() to remove yt-dlp artifacts"
```

---

### Task 4: Implement `download_with_retry()`

**Files:**
- Modify: `downloader.py` — insert after `cleanup_fragments()`

- [ ] **Step 1: Add `download_with_retry` function**

Insert immediately after `cleanup_fragments()`:

```python
def download_with_retry(video_id: str, output_dir: str, filename_base: str,
                        ytdlp_opts: dict | None = None,
                        max_retries: int = 3,
                        retry_delay: int = 10) -> str | None:
    """Download a video with retry, validation, and fragment cleanup.

    Orchestrates download_video(), validate_download(), and
    cleanup_fragments() with configurable retries and linear backoff.

    Returns the validated output filepath on success, or None if all
    retries are exhausted.
    """
    opts = ytdlp_opts or {}
    format_string = opts.get("format", "bestvideo+bestaudio/best")

    for attempt in range(1, max_retries + 1):
        log.info("Attempt %d/%d: downloading %s", attempt, max_retries, video_id)

        cleanup_fragments(output_dir, filename_base)

        filepath = download_video(video_id, output_dir, filename_base, ytdlp_opts)

        if filepath is None:
            log.warning("Attempt %d/%d failed for %s: download returned no file",
                        attempt, max_retries, video_id)
            if attempt < max_retries:
                delay = retry_delay * attempt
                log.info("Sleeping %ds before retry", delay)
                time.sleep(delay)
            continue

        valid, reason = validate_download(filepath, format_string)
        if valid:
            return filepath

        log.warning("Attempt %d/%d failed for %s: validation failed: %s",
                    attempt, max_retries, video_id, reason)
        try:
            os.remove(filepath)
        except OSError:
            pass

        if attempt < max_retries:
            delay = retry_delay * attempt
            log.info("Sleeping %ds before retry", delay)
            time.sleep(delay)

    log.error("All %d attempts failed for %s", max_retries, video_id)
    cleanup_fragments(output_dir, filename_base)
    return None
```

- [ ] **Step 2: Commit**

```bash
git add downloader.py
git commit -m "feat: add download_with_retry() orchestrator"
```

---

## Chunk 2: Modify Existing Functions

### Task 5: Extend `load_config()` validation

**Files:**
- Modify: `downloader.py:90-116` (`load_config` function)

- [ ] **Step 1: Add top-level config validation**

After the existing line `if not config or "feeds" not in config:` block (line 95-96), add validation for the new top-level key. The full function becomes:

Replace the section from `if not config or "feeds" not in config:` through the end of `load_config` (lines 95-116) with:

```python
    if not config or "feeds" not in config:
        raise ValueError(f"Config file {config_path} must contain a 'feeds' key")

    max_dl = config.get("max_downloads_per_run", 0)
    if not isinstance(max_dl, int) or max_dl < 0:
        raise ValueError("'max_downloads_per_run' must be a non-negative integer")

    for i, feed in enumerate(config["feeds"]):
        for required in ("name", "url_env", "default_path"):
            if required not in feed:
                raise ValueError(
                    f"Feed #{i} ({feed.get('name', 'unnamed')}) "
                    f"missing required key: {required}"
                )
        feed.setdefault("retention_days", 0)
        feed.setdefault("series", [])

        # Validate ytdlp retry options
        ytdlp = feed.get("ytdlp") or {}
        max_retries = ytdlp.get("max_retries")
        if max_retries is not None:
            if not isinstance(max_retries, int) or max_retries < 1:
                raise ValueError(
                    f"Feed '{feed['name']}': ytdlp.max_retries must be "
                    f"a positive integer"
                )
        retry_delay = ytdlp.get("retry_delay")
        if retry_delay is not None:
            if not isinstance(retry_delay, (int, float)) or retry_delay < 0:
                raise ValueError(
                    f"Feed '{feed['name']}': ytdlp.retry_delay must be "
                    f"a non-negative number"
                )

        for series in feed["series"]:
            if "pattern" not in series or "path" not in series:
                raise ValueError(
                    f"Feed '{feed['name']}' has a series entry "
                    f"missing 'pattern' or 'path'"
                )
            series["_compiled"] = re.compile(series["pattern"])

    return config
```

- [ ] **Step 2: Commit**

```bash
git add downloader.py
git commit -m "feat: validate max_downloads_per_run and ytdlp retry config"
```

---

### Task 6: Modify `process_feed()` — use orchestrator, budget, state fix

**Files:**
- Modify: `downloader.py:487-616` (`process_feed` function)

This is the critical bugfix task. Three changes:
1. Add `remaining_budget` parameter
2. Replace `download_video()` with `download_with_retry()`
3. Only record successful downloads in state (move state write inside `if filepath:`)

- [ ] **Step 1: Update function signature and add budget check**

Replace the function signature and add budget parameter handling. Change line 487:

```python
def process_feed(feed_config: dict, state: dict, state_path: Path) -> int:
```

to:

```python
def process_feed(feed_config: dict, state: dict, state_path: Path,
                 remaining_budget: int = 0) -> int:
```

- [ ] **Step 2: Replace the download call and fix state recording**

Replace the block from `for video_id in video_ids:` through `downloaded += 1` (lines 548-602) with:

```python
        for video_id in video_ids:
            if video_id in state:
                skip_count += 1
                continue

            # Check download budget
            if remaining_budget > 0 and downloaded >= remaining_budget:
                log.info("Download budget exhausted (%d), skipping remaining",
                         remaining_budget)
                break

            match = match_series(title, feed_config)
            if match is None:
                log.debug("Skipping unmatched video: %s (ID: %s)", title, video_id)
                continue
            series_name, base_path, poster_url = match
            log.info(
                "New video: %s (ID: %s) -> %s [%s]",
                title,
                video_id,
                series_name,
                base_path,
            )

            # Build Plex-compatible path: Series/Season YYYY/
            season, episode = plex_episode_id(pub_date, series_name, state, feed_name)
            season_dir = os.path.join(base_path, f"Season {season}")
            Path(season_dir).mkdir(parents=True, exist_ok=True)

            # Write tvshow.nfo in series root
            write_tvshow_nfo(Path(base_path), series_name, poster_url)

            # Generate Plex filename
            fname = plex_filename(series_name, season, episode, title)

            ytdlp_opts = feed_config.get("ytdlp") or {}
            filepath = download_with_retry(
                video_id, season_dir, fname,
                ytdlp_opts,
                max_retries=ytdlp_opts.get("max_retries", 3),
                retry_delay=ytdlp_opts.get("retry_delay", 10),
            )

            if filepath:
                # Write episode NFO
                aired = pub_date.strftime("%Y-%m-%d") if pub_date else ""
                description = get_entry_description(entry)
                nfo_path = Path(filepath).with_suffix(".nfo")
                write_episode_nfo(nfo_path, title, series_name,
                                  description, aired, season, episode)

                state[video_id] = {
                    "title": title,
                    "published_at": pub_date.isoformat() if pub_date else None,
                    "downloaded_at": datetime.now(timezone.utc).isoformat(),
                    "series": series_name,
                    "path": season_dir,
                    "file": filepath,
                    "feed": feed_name,
                    "season": season,
                    "episode": episode,
                }

                save_state(state, state_path)
                downloaded += 1

        # Break outer loop if budget exhausted
        if remaining_budget > 0 and downloaded >= remaining_budget:
            break
```

The outer-loop budget break is included at the end of the replacement block (at `for entry` indentation level, after the `for video_id` loop). This ensures both loops exit when the budget is spent.

- [ ] **Step 3: Verify pruning still runs unconditionally**

Confirm that `prune_old_entries()` (currently line 614) remains outside and after the download loop — it must not be gated by the budget. No code change needed here, just verification that the existing call at the end of `process_feed()` is untouched.

- [ ] **Step 4: Commit**

```bash
git add downloader.py
git commit -m "fix: only record successful downloads in state, add retry and budget

Failed downloads are no longer recorded in state.json, so they will be
retried on the next CronJob run. Downloads use the new retry orchestrator
with post-download validation. A remaining_budget parameter caps downloads
per feed invocation."
```

---

### Task 7: Modify `main()` for download budget

**Files:**
- Modify: `downloader.py:624-653` (`main` function)

- [ ] **Step 1: Add budget tracking to main loop**

Replace lines 642-647 (the feed processing loop) with:

```python
    max_downloads = config.get("max_downloads_per_run", 0)
    if max_downloads > 0:
        log.info("Download budget: %d per run", max_downloads)

    total_new = 0
    for feed_config in config["feeds"]:
        if max_downloads > 0 and total_new >= max_downloads:
            log.info("Global download budget exhausted (%d), skipping remaining feeds",
                     max_downloads)
            break

        remaining = (max_downloads - total_new) if max_downloads > 0 else 0
        try:
            total_new += process_feed(feed_config, state, state_path,
                                      remaining_budget=remaining)
        except Exception:
            log.exception("Error processing feed '%s'", feed_config["name"])
```

- [ ] **Step 2: Commit**

```bash
git add downloader.py
git commit -m "feat: add max_downloads_per_run budget to main loop"
```

---

## Chunk 3: Verification

### Task 8: Manual verification

- [ ] **Step 1: Syntax check**

```bash
python -m py_compile downloader.py
```

Expected: no output (success).

- [ ] **Step 2: Verify all new functions exist and are callable**

```bash
python -c "
from downloader import (
    validate_download, cleanup_fragments, download_with_retry,
    load_config, process_feed, main
)
print('All imports OK')
"
```

Expected: `All imports OK`

- [ ] **Step 3: Verify load_config rejects bad values**

```bash
python -c "
import yaml, tempfile, os
from pathlib import Path
from downloader import load_config

# Test: bad max_downloads_per_run
with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
    yaml.dump({'max_downloads_per_run': -1, 'feeds': []}, f)
    f.flush()
    try:
        load_config(Path(f.name))
        print('FAIL: should have raised')
    except ValueError as e:
        print(f'OK: {e}')
    finally:
        os.unlink(f.name)
"
```

Expected: `OK: 'max_downloads_per_run' must be a non-negative integer`

- [ ] **Step 4: Final commit (if any adjustments needed)**

Only if syntax/import checks revealed issues.
