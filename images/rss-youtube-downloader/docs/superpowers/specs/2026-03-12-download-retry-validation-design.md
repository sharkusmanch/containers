# Download Retry & Validation

## Problem

Two failure modes go undetected and are never retried:

1. **Audio-only fallback** (E0690) — yt-dlp exits 0 but produces only an `.m4a` file with no video stream, plus a 0-byte `.temp.m4a`. No video was downloaded.
2. **Failed merge** (E0700) — yt-dlp downloads separate stream fragments (`.f251.webm`, `.f399.mp4.part`) but crashes mid-merge. The fragments are left on disk, unmerged.

Both are caused by the same root issue: `process_feed()` records every video in `state.json` regardless of download outcome (lines 589-601). Once in state, the `video_id in state` check (line 549) skips the video forever. There is no retry logic and no post-download validation.

## Design

### Approach

New functions with single responsibilities, composed by a thin orchestrator. The existing `download_video()` stays unchanged as a single-attempt yt-dlp wrapper.

### New function: `validate_download(filepath, format_string) -> (bool, str | None)`

Validates a downloaded file using ffprobe:

- **File exists and is non-zero size.** Returns `(False, "file missing or empty")` otherwise.
- **Stream check based on requested format:**
  - If `format_string` contains `"video"` (e.g. `bestvideo+bestaudio/best`): require both video and audio streams.
  - Otherwise: require at least an audio stream.
- **ffprobe invocation:** `ffprobe -v error -show_entries stream=codec_type -of json <filepath>`. Parse JSON output, count stream types.
- Returns `(True, None)` on success, `(False, reason)` on failure.

ffprobe is already available in the container (installed via the ffmpeg Alpine package).

### New function: `cleanup_fragments(output_dir, filename_base) -> None`

Removes leftover yt-dlp artifacts scoped to a specific episode:

- Globs `{output_dir}/{filename_base}.*` to find candidates.
- Deletes files matching any of:
  - `.part` suffix (incomplete downloads)
  - `.temp.` in filename (temporary processing files)
  - `.f\d+.` pattern in filename (unmerged stream fragments like `.f251.webm`, `.f399.mp4`)
- Logs each deletion.
- Silently ignores missing files (race-safe).

Scoped to the filename base to avoid touching other episodes in the same directory.

### New function: `download_with_retry(video_id, output_dir, filename_base, ytdlp_opts, max_retries, retry_delay) -> str | None`

Orchestrates download, validation, cleanup, and retry:

1. For each attempt (1 to `max_retries`):
   a. `cleanup_fragments(output_dir, filename_base)` — clear debris from prior attempt.
   b. `download_video(video_id, output_dir, filename_base, ytdlp_opts)` — existing function.
   c. If `download_video()` returns `None` (yt-dlp error or timeout): log, sleep, continue to next attempt.
   d. If it returns a filepath: `validate_download(filepath, format_string)`.
   e. If validation passes: return filepath (success).
   f. If validation fails: log the reason, delete the invalid output file, sleep, continue.
2. After all retries exhausted: `cleanup_fragments()` one final time, return `None`.

**Backoff:** Linear — `retry_delay * attempt` seconds (e.g. 10s, 20s, 30s with defaults).

Parameters `max_retries` and `retry_delay` come from the per-feed `ytdlp` config, with defaults.

### Changes to `download_video()`

None. It remains a single-attempt yt-dlp wrapper returning filepath or `None`.

### Changes to `process_feed()`

**Call `download_with_retry()` instead of `download_video()`:**

```python
filepath = download_with_retry(
    video_id, season_dir, fname,
    feed_config.get("ytdlp"),
    max_retries=ytdlp_opts.get("max_retries", 3),
    retry_delay=ytdlp_opts.get("retry_delay", 10),
)
```

**Only record successful downloads in state:**

Move the `state[video_id] = {...}` block and `save_state()` call inside the existing `if filepath:` branch. When `filepath` is `None`, the video is not recorded — the next CronJob run will see it as new and try again.

Before (buggy):
```python
filepath = download_video(...)
if filepath:
    # write NFO...

state[video_id] = { "file": filepath, ... }  # Always recorded
save_state(state, state_path)
```

After (fixed):
```python
filepath = download_with_retry(...)
if filepath:
    # write NFO...
    state[video_id] = { "file": filepath, ... }
    save_state(state, state_path)
    downloaded += 1
```

**Respect `max_downloads_per_run` budget:**

`process_feed()` gains a `remaining_budget` parameter (int, 0 = unlimited). When budget is exhausted, skip remaining entries without recording them in state. Return the count of successful downloads.

### Changes to `main()`

Read `max_downloads_per_run` from top-level config (default 0 = unlimited). Track running total across feeds. Pass remaining budget to each `process_feed()` call. Stop processing feeds early if budget is fully spent.

### Configuration

**Per-feed `ytdlp` section** (existing, two new optional keys):

```yaml
ytdlp:
  format: "bestvideo+bestaudio/best"    # existing
  merge_output_format: "mp4"             # existing
  extra_args: []                         # existing
  max_retries: 3                         # new, default 3
  retry_delay: 10                        # new, base delay in seconds, default 10
```

**Top-level config** (new optional key):

```yaml
max_downloads_per_run: 0   # 0 = unlimited (default)
```

Global across all feeds. When set to e.g. 5, at most 5 videos are downloaded per CronJob invocation. Remaining new videos are left unrecorded and will be picked up by subsequent runs. This prevents YouTube rate-limiting/flagging during backlog catch-up.

### Config validation

`load_config()` gains:
- Validate `max_downloads_per_run` is a non-negative integer if present.
- Validate `max_retries` is a positive integer if present.
- Validate `retry_delay` is a non-negative number if present.

### Dependencies

No new dependencies. ffprobe is part of the ffmpeg Alpine package already in the Dockerfile. All other imports are Python stdlib (`glob`, `json`, `time`).

No Dockerfile changes required.

## Summary of changes

| File | Change |
|------|--------|
| `downloader.py` | Add `validate_download()`, `cleanup_fragments()`, `download_with_retry()`. Modify `process_feed()` to use orchestrator and only record successes. Modify `main()` for download budget. Extend `load_config()` validation. |
| `Dockerfile` | None |
| `requirements.txt` | None |
| `config.yaml` | New optional keys: `ytdlp.max_retries`, `ytdlp.retry_delay`, `max_downloads_per_run` |

## What this does NOT cover

- Alerting on repeated failures (could be added later via Prometheus metrics or log-based alerts).
- Retrying the two already-broken episodes (E0690, E0700) — these need manual cleanup: delete their entries from `state.json` and remove the fragment files, then the next run will re-download them.
