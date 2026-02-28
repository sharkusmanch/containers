#!/usr/bin/env python3
"""RSS YouTube Downloader.

Reads RSS feeds (e.g. Patreon podcast feeds), extracts YouTube URLs from
entry descriptions, and downloads them via yt-dlp. Videos are organized
into series folders based on regex pattern matching against entry titles.

Designed to run as a Kubernetes CronJob every 6 hours.
"""

import calendar
import json
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import yaml

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("rss-youtube-downloader")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

YOUTUBE_URL_RE = re.compile(
    r"(?:https?://)?(?:"
    r"(?:www\.)?youtube\.com/watch\?v="
    r"|youtu\.be/"
    r")"
    r"([\w-]{11})"
)

OUTPUT_TEMPLATE = "%(title)s [%(id)s].%(ext)s"
DOWNLOAD_TIMEOUT = 1800  # 30 minutes per video


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------


def load_state(state_path: Path) -> dict:
    """Load the download state from a JSON file."""
    if state_path.exists():
        try:
            with open(state_path, "r") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Failed to load state file %s: %s", state_path, exc)
    return {}


def save_state(state: dict, state_path: Path) -> None:
    """Atomically save the download state to a JSON file."""
    tmp_path = state_path.with_suffix(".tmp")
    try:
        with open(tmp_path, "w") as fh:
            json.dump(state, fh, indent=2)
        tmp_path.replace(state_path)
    except OSError as exc:
        log.error("Failed to save state file %s: %s", state_path, exc)
        # Clean up temp file on failure
        tmp_path.unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def load_config(config_path: Path) -> dict:
    """Load and validate the YAML configuration file."""
    with open(config_path, "r") as fh:
        config = yaml.safe_load(fh)

    if not config or "feeds" not in config:
        raise ValueError(f"Config file {config_path} must contain a 'feeds' key")

    for i, feed in enumerate(config["feeds"]):
        for required in ("name", "url_env", "default_path"):
            if required not in feed:
                raise ValueError(
                    f"Feed #{i} ({feed.get('name', 'unnamed')}) "
                    f"missing required key: {required}"
                )
        # Default retention_days to 0 (no pruning) if not set
        feed.setdefault("retention_days", 0)
        feed.setdefault("series", [])

        # Pre-compile series patterns
        for series in feed["series"]:
            if "pattern" not in series or "path" not in series:
                raise ValueError(
                    f"Feed '{feed['name']}' has a series entry "
                    f"missing 'pattern' or 'path'"
                )
            series["_compiled"] = re.compile(series["pattern"])

    return config


# ---------------------------------------------------------------------------
# YouTube URL extraction
# ---------------------------------------------------------------------------


def extract_youtube_ids(entry) -> list[str]:
    """Extract unique YouTube video IDs from a feed entry.

    Searches the entry summary, content blocks, and link fields.
    Returns a deduplicated list of 11-character video IDs.
    """
    texts = []

    # Summary / description
    if hasattr(entry, "summary"):
        texts.append(entry.summary)

    # Content blocks (Atom feeds)
    if hasattr(entry, "content"):
        for content_block in entry.content:
            texts.append(content_block.get("value", ""))

    # Direct links
    if hasattr(entry, "links"):
        for link in entry.links:
            texts.append(link.get("href", ""))

    # Entry link
    if hasattr(entry, "link"):
        texts.append(entry.link)

    combined = " ".join(texts)
    ids = YOUTUBE_URL_RE.findall(combined)
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for vid in ids:
        if vid not in seen:
            seen.add(vid)
            unique.append(vid)
    return unique


# ---------------------------------------------------------------------------
# Series matching
# ---------------------------------------------------------------------------


def match_series(title: str, feed_config: dict) -> tuple[str, str]:
    """Match an entry title against series patterns.

    Returns (series_name, download_path). Falls back to
    ("Unsorted", default_path) if no pattern matches.
    """
    for series in feed_config["series"]:
        if series["_compiled"].search(title):
            return series.get("name", "Unknown"), series["path"]
    return "Unsorted", feed_config["default_path"]


# ---------------------------------------------------------------------------
# Downloading
# ---------------------------------------------------------------------------


def download_video(video_id: str, output_dir: str,
                    ytdlp_opts: dict | None = None) -> str | None:
    """Download a YouTube video using yt-dlp.

    Returns the output filename on success, or None on failure.
    """
    opts = ytdlp_opts or {}
    fmt = opts.get("format", "bestvideo+bestaudio/best")
    merge_format = opts.get("merge_output_format", "mkv")
    output_template = opts.get("output_template", OUTPUT_TEMPLATE)
    extra_args = opts.get("extra_args", [])

    output_path = os.path.join(output_dir, output_template)
    url = f"https://www.youtube.com/watch?v={video_id}"

    cmd = [
        "yt-dlp",
        "--format", fmt,
        "--merge-output-format", merge_format,
        "--embed-metadata",
        "--embed-thumbnail",
        "--output", output_path,
        "--no-progress",
        "--print", "after_move:filepath",
        *extra_args,
        url,
    ]

    log.info("Downloading %s to %s", url, output_dir)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=DOWNLOAD_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        log.error("Download timed out after %ds for %s", DOWNLOAD_TIMEOUT, video_id)
        return None

    if result.returncode != 0:
        log.error(
            "yt-dlp failed for %s (exit %d): %s",
            video_id,
            result.returncode,
            result.stderr.strip(),
        )
        return None

    # Extract the final filepath from yt-dlp --print output
    filepath = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else None
    if filepath:
        log.info("Downloaded: %s", filepath)
        return filepath

    # Fallback: construct expected filename
    log.warning("Could not determine output filename for %s", video_id)
    return None


# ---------------------------------------------------------------------------
# Pruning
# ---------------------------------------------------------------------------


def prune_old_entries(state: dict, feed_name: str, retention_days: int,
                      state_path: Path) -> None:
    """Remove entries older than retention_days and delete their files."""
    if retention_days <= 0:
        return

    now = datetime.now(timezone.utc)
    to_remove = []

    for video_id, entry in state.items():
        if entry.get("feed") != feed_name:
            continue

        downloaded_at = entry.get("downloaded_at")
        if not downloaded_at:
            continue

        try:
            dl_time = datetime.fromisoformat(downloaded_at)
        except (ValueError, TypeError):
            continue

        age_days = (now - dl_time).total_seconds() / 86400
        if age_days > retention_days:
            to_remove.append(video_id)

    if not to_remove:
        return

    log.info(
        "Pruning %d video(s) older than %d days from feed '%s'",
        len(to_remove),
        retention_days,
        feed_name,
    )

    for video_id in to_remove:
        entry = state[video_id]
        filepath = entry.get("file")

        if filepath:
            try:
                p = Path(filepath)
                if p.exists():
                    p.unlink()
                    log.info("Deleted file: %s", filepath)
                else:
                    log.debug("File already gone: %s", filepath)
            except OSError as exc:
                log.warning("Failed to delete %s: %s", filepath, exc)

        del state[video_id]
        log.info("Pruned video %s (%s)", video_id, entry.get("title", "unknown"))

    save_state(state, state_path)


# ---------------------------------------------------------------------------
# Entry age
# ---------------------------------------------------------------------------


def entry_published_date(entry) -> datetime | None:
    """Extract the published date from a feed entry."""
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        ts = calendar.timegm(entry.published_parsed)
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    return None


# ---------------------------------------------------------------------------
# Feed processing
# ---------------------------------------------------------------------------


def process_feed(feed_config: dict, state: dict, state_path: Path) -> None:
    """Process a single RSS feed: download new videos and prune old ones."""
    feed_name = feed_config["name"]
    url_env = feed_config["url_env"]
    feed_url = os.environ.get(url_env)

    if not feed_url:
        log.error(
            "Feed '%s': environment variable %s is not set, skipping",
            feed_name,
            url_env,
        )
        return

    log.info("Processing feed: %s", feed_name)

    parsed = feedparser.parse(feed_url)
    if parsed.bozo and not parsed.entries:
        log.error(
            "Feed '%s': failed to parse RSS (%s)",
            feed_name,
            parsed.bozo_exception,
        )
        return

    if parsed.bozo:
        log.warning(
            "Feed '%s': parser warning: %s",
            feed_name,
            parsed.bozo_exception,
        )

    log.info("Feed '%s': found %d entries", feed_name, len(parsed.entries))

    retention_days = feed_config["retention_days"]
    age_cutoff = None
    if retention_days > 0:
        age_cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    new_count = 0
    skip_count = 0
    old_count = 0

    for entry in parsed.entries:
        title = entry.get("title", "Untitled")

        # Skip entries older than retention_days (avoid downloading then pruning)
        if age_cutoff:
            pub_date = entry_published_date(entry)
            if pub_date and pub_date < age_cutoff:
                old_count += 1
                continue

        video_ids = extract_youtube_ids(entry)

        if not video_ids:
            continue

        for video_id in video_ids:
            if video_id in state:
                skip_count += 1
                continue

            series_name, download_path = match_series(title, feed_config)
            log.info(
                "New video: %s (ID: %s) -> %s [%s]",
                title,
                video_id,
                series_name,
                download_path,
            )

            # Ensure output directory exists
            Path(download_path).mkdir(parents=True, exist_ok=True)

            filepath = download_video(
                video_id, download_path, feed_config.get("ytdlp")
            )

            # Record in state regardless of download success to avoid retrying
            # permanently broken videos. The file field will be None on failure.
            state[video_id] = {
                "title": title,
                "downloaded_at": datetime.now(timezone.utc).isoformat(),
                "series": series_name,
                "path": download_path,
                "file": filepath,
                "feed": feed_name,
            }

            save_state(state, state_path)
            new_count += 1

    log.info(
        "Feed '%s': %d new, %d already downloaded, %d skipped (older than %d days)",
        feed_name,
        new_count,
        skip_count,
        old_count,
        retention_days,
    )

    # Prune old entries
    prune_old_entries(state, feed_name, feed_config["retention_days"], state_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    """Entry point."""
    config_path = Path(os.environ.get("CONFIG_FILE", "/config/config.yaml"))
    state_path = Path(os.environ.get("STATE_FILE", "/config/state.json"))

    log.info("Starting rss-youtube-downloader")
    log.info("Config: %s", config_path)
    log.info("State: %s", state_path)

    try:
        config = load_config(config_path)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        log.error("Failed to load config: %s", exc)
        return 1

    state = load_state(state_path)
    log.info("Loaded state with %d tracked video(s)", len(state))

    for feed_config in config["feeds"]:
        try:
            process_feed(feed_config, state, state_path)
        except Exception:
            log.exception("Error processing feed '%s'", feed_config["name"])
            # Continue with remaining feeds

    log.info("Finished. Tracking %d video(s) total.", len(state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
