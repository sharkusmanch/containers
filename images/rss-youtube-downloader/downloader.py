#!/usr/bin/env python3
"""RSS YouTube Downloader.

Reads RSS feeds (e.g. Patreon podcast feeds), extracts YouTube URLs from
entry descriptions, and downloads them via yt-dlp. Videos are organized
into Plex TV Shows-compatible folder structure with NFO metadata.

Designed to run as a Kubernetes CronJob every 6 hours.
"""

import calendar
import html
import json
import logging
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

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

HTML_TAG_RE = re.compile(r"<[^>]+>")

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
        feed.setdefault("retention_days", 0)
        feed.setdefault("series", [])

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
    """Extract unique YouTube video IDs from a feed entry."""
    texts = []

    if hasattr(entry, "summary"):
        texts.append(entry.summary)

    if hasattr(entry, "content"):
        for content_block in entry.content:
            texts.append(content_block.get("value", ""))

    if hasattr(entry, "links"):
        for link in entry.links:
            texts.append(link.get("href", ""))

    if hasattr(entry, "link"):
        texts.append(entry.link)

    combined = " ".join(texts)
    ids = YOUTUBE_URL_RE.findall(combined)
    seen = set()
    unique = []
    for vid in ids:
        if vid not in seen:
            seen.add(vid)
            unique.append(vid)
    return unique


# ---------------------------------------------------------------------------
# HTML / text helpers
# ---------------------------------------------------------------------------


def strip_html(text: str) -> str:
    """Strip HTML tags and decode entities."""
    text = HTML_TAG_RE.sub("", text)
    return html.unescape(text).strip()


def get_entry_description(entry) -> str:
    """Extract plain-text description from a feed entry."""
    raw = ""
    if hasattr(entry, "content"):
        for block in entry.content:
            raw += block.get("value", "")
    if not raw and hasattr(entry, "summary"):
        raw = entry.summary
    return strip_html(raw)


# ---------------------------------------------------------------------------
# Series matching
# ---------------------------------------------------------------------------


def match_series(title: str, feed_config: dict) -> tuple[str, str, str | None] | None:
    """Match an entry title against series patterns.

    Returns (series_name, download_path, poster_url) or None if no
    pattern matches and skip_unmatched is true.
    """
    for series in feed_config["series"]:
        if series["_compiled"].search(title):
            return (series.get("name", "Unknown"), series["path"],
                    series.get("poster_url"))

    if feed_config.get("skip_unmatched", False):
        return None

    return "Unsorted", feed_config["default_path"], None


# ---------------------------------------------------------------------------
# Plex naming and metadata
# ---------------------------------------------------------------------------


def plex_episode_id(pub_date: datetime | None, series_name: str,
                    state: dict, feed_name: str) -> tuple[int, int]:
    """Generate Plex season/episode numbers from publish date.

    Season = year, Episode = day-of-year * 10 + index for same-day dupes.
    """
    if not pub_date:
        pub_date = datetime.now(timezone.utc)

    season = pub_date.year
    day_of_year = pub_date.timetuple().tm_yday

    # Find existing episodes on same day in same series
    existing = 0
    for entry in state.values():
        if entry.get("feed") != feed_name or entry.get("series") != series_name:
            continue
        if entry.get("season") == season and entry.get("episode", 0) // 10 == day_of_year:
            existing += 1

    episode = day_of_year * 10 + existing
    return season, episode


def plex_filename(series_name: str, season: int, episode: int,
                  title: str) -> str:
    """Generate Plex-compatible filename (without extension).

    Format: Series Name - S2026E0580 - Episode Title
    Note: no brackets — Plex strips bracket content when matching NFO files.
    """
    # Clean title for filesystem safety
    clean_title = re.sub(r'[<>:"/\\|?*\[\]]', '', title)
    clean_title = clean_title.strip('. ')
    # Truncate to avoid filesystem path length limits
    if len(clean_title) > 150:
        clean_title = clean_title[:150].strip()

    return f"{series_name} - S{season:04d}E{episode:04d} - {clean_title}"


def write_episode_nfo(nfo_path: Path, title: str, series_name: str,
                      plot: str, aired: str, season: int, episode: int) -> None:
    """Write a Kodi/Plex-compatible episode NFO file."""
    root = Element("episodedetails")
    SubElement(root, "title").text = title
    SubElement(root, "showtitle").text = series_name
    SubElement(root, "plot").text = plot
    SubElement(root, "aired").text = aired
    SubElement(root, "season").text = str(season)
    SubElement(root, "episode").text = str(episode)

    xml_bytes = tostring(root, encoding="unicode", xml_declaration=False)
    nfo_path.write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n{xml_bytes}\n')
    log.info("Wrote NFO: %s", nfo_path)


def write_tvshow_nfo(series_dir: Path, series_name: str,
                     poster_url: str | None = None) -> None:
    """Write a tvshow.nfo in the series root if it doesn't exist."""
    nfo_path = series_dir / "tvshow.nfo"
    if not nfo_path.exists():
        root = Element("tvshow")
        SubElement(root, "title").text = series_name
        SubElement(root, "plot").text = f"{series_name} - downloaded from RSS feed"
        if poster_url:
            SubElement(root, "thumb", aspect="poster").text = poster_url

        xml_bytes = tostring(root, encoding="unicode", xml_declaration=False)
        nfo_path.write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n{xml_bytes}\n')
        log.info("Wrote tvshow.nfo: %s", nfo_path)

    # Download poster if configured and not already present
    if poster_url:
        poster_path = series_dir / "poster.jpg"
        if not poster_path.exists():
            try:
                urllib.request.urlretrieve(poster_url, poster_path)
                log.info("Downloaded poster: %s", poster_path)
            except Exception as exc:
                log.warning("Failed to download poster for %s: %s",
                            series_name, exc)


# ---------------------------------------------------------------------------
# Downloading
# ---------------------------------------------------------------------------


def download_video(video_id: str, output_dir: str, filename_base: str,
                   ytdlp_opts: dict | None = None) -> str | None:
    """Download a YouTube video using yt-dlp.

    Returns the output filepath on success, or None on failure.
    """
    opts = ytdlp_opts or {}
    fmt = opts.get("format", "bestvideo+bestaudio/best")
    merge_format = opts.get("merge_output_format", "mp4")
    extra_args = opts.get("extra_args", [])

    output_template = os.path.join(output_dir, f"{filename_base}.%(ext)s")
    url = f"https://www.youtube.com/watch?v={video_id}"

    cmd = [
        "yt-dlp",
        "--format", fmt,
        "--merge-output-format", merge_format,
        "--embed-metadata",
        "--embed-thumbnail",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
        "--output", output_template,
        "--output", f"thumbnail:{os.path.join(output_dir, filename_base)}.%(ext)s",
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

    filepath = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else None
    if filepath:
        log.info("Downloaded: %s", filepath)
        return filepath

    log.warning("Could not determine output filename for %s", video_id)
    return None


# ---------------------------------------------------------------------------
# Pruning
# ---------------------------------------------------------------------------


def prune_old_entries(state: dict, feed_name: str, feed_config: dict,
                      state_path: Path) -> None:
    """Remove entries older than retention_days based on RSS publish date.

    Per-series retention_days overrides the feed-level default.
    """
    feed_retention = feed_config.get("retention_days", 0)
    if feed_retention <= 0:
        return

    # Build series -> retention_days lookup
    series_retention = {}
    for series in feed_config.get("series", []):
        if "retention_days" in series:
            series_retention[series.get("name", "")] = series["retention_days"]

    now = datetime.now(timezone.utc)
    to_remove = []

    for video_id, entry in state.items():
        if entry.get("feed") != feed_name:
            continue

        # Use RSS publish date; fall back to downloaded_at for old state entries
        pub_date_str = entry.get("published_at") or entry.get("downloaded_at")
        if not pub_date_str:
            continue

        try:
            pub_time = datetime.fromisoformat(pub_date_str)
        except (ValueError, TypeError):
            continue

        # Per-series retention overrides feed default
        series_name = entry.get("series", "")
        retention_days = series_retention.get(series_name, feed_retention)
        if retention_days <= 0:
            continue

        age_days = (now - pub_time).total_seconds() / 86400
        if age_days > retention_days:
            to_remove.append(video_id)

    if not to_remove:
        return

    log.info(
        "Pruning %d video(s) from feed '%s'",
        len(to_remove),
        feed_name,
    )

    for video_id in to_remove:
        entry = state[video_id]
        filepath = entry.get("file")

        if filepath:
            p = Path(filepath)
            # Delete video file
            try:
                if p.exists():
                    p.unlink()
                    log.info("Deleted file: %s", filepath)
            except OSError as exc:
                log.warning("Failed to delete %s: %s", filepath, exc)

            # Delete sidecar files (nfo, jpg thumbnail)
            stem = p.with_suffix("")
            for sidecar in [stem.with_suffix(".nfo"), stem.with_suffix(".jpg")]:
                try:
                    if sidecar.exists():
                        sidecar.unlink()
                        log.info("Deleted sidecar: %s", sidecar)
                except OSError as exc:
                    log.warning("Failed to delete %s: %s", sidecar, exc)

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

        # Skip entries older than retention_days
        pub_date = entry_published_date(entry)
        if age_cutoff:
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

            filepath = download_video(
                video_id, season_dir, fname, feed_config.get("ytdlp")
            )

            # Write episode NFO
            if filepath:
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
    prune_old_entries(state, feed_name, feed_config, state_path)


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

    log.info("Finished. Tracking %d video(s) total.", len(state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
