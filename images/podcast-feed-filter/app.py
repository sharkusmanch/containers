import logging
import os
import re
import threading
import time

import requests
import yaml
from flask import Flask, Response, abort, jsonify
from lxml import etree

app = Flask(__name__)
log = logging.getLogger(__name__)

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")
DEFAULT_REFRESH = 300

# Pre-computed filtered feeds: {name: {"data": bytes, "time": float}}
_feed_cache = {}
_cache_lock = threading.Lock()


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def _fetch_upstream(url):
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.content


def _stale_feeds(config):
    """Return feed names that are due for refresh."""
    now = time.time()
    default_ttl = config.get("refresh_interval", DEFAULT_REFRESH)
    stale = []
    for name, fc in config.get("feeds", {}).items():
        ttl = fc.get("refresh_interval", default_ttl)
        with _cache_lock:
            entry = _feed_cache.get(name)
        if not entry or now - entry["time"] >= ttl:
            stale.append(name)
    return stale


def refresh_feeds(force=False):
    """Fetch upstream and pre-compute stale (or all if force) filtered feeds."""
    config = load_config()
    feeds = config.get("feeds", {})
    to_refresh = list(feeds.keys()) if force else _stale_feeds(config)
    if not to_refresh:
        return

    # Group by source URL to fetch once per upstream
    by_source = {}
    for name in to_refresh:
        fc = feeds[name]
        source = os.path.expandvars(fc["source"])
        by_source.setdefault(source, []).append((name, fc))

    now = time.time()
    refreshed = 0
    for source, feed_list in by_source.items():
        try:
            xml_bytes = _fetch_upstream(source)
        except Exception:
            log.exception("Failed to fetch %s", source)
            continue
        for name, fc in feed_list:
            try:
                overrides = {k: fc[k] for k in ("title", "description", "image") if k in fc}
                data = filter_feed(xml_bytes, fc["match"], overrides or None)
                with _cache_lock:
                    _feed_cache[name] = {"data": data, "time": now}
                refreshed += 1
            except Exception:
                log.exception("Failed to filter feed %s", name)

    log.info("Refreshed %d/%d feeds", refreshed, len(to_refresh))


def _background_refresh():
    """Check for stale feeds every 30s."""
    while True:
        time.sleep(30)
        try:
            refresh_feeds()
        except Exception:
            log.exception("Background refresh failed")


def filter_feed(xml_bytes, pattern, overrides=None):
    tree = etree.fromstring(xml_bytes)
    regex = re.compile(pattern, re.IGNORECASE)
    for item in tree.xpath("//item"):
        title = item.findtext("title", default="")
        if not regex.search(title):
            item.getparent().remove(item)
    if overrides:
        channel = tree.find(".//channel")
        if channel is not None:
            _apply_overrides(channel, overrides)
    return etree.tostring(tree, xml_declaration=True, encoding="UTF-8")


ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"


def _apply_overrides(channel, overrides):
    if "title" in overrides:
        for el in channel.findall("title"):
            el.text = overrides["title"]
        itunes_author = channel.find(f"{{{ITUNES_NS}}}author")
        if itunes_author is not None:
            itunes_author.text = overrides["title"]
        itunes_owner = channel.find(f"{{{ITUNES_NS}}}owner")
        if itunes_owner is not None:
            itunes_name = itunes_owner.find(f"{{{ITUNES_NS}}}name")
            if itunes_name is not None:
                itunes_name.text = overrides["title"]
        plain_img = channel.find("image")
        if plain_img is not None:
            img_title = plain_img.find("title")
            if img_title is not None:
                img_title.text = overrides["title"]
    if "description" in overrides:
        for el in channel.findall("description"):
            el.text = overrides["description"]
    if "image" in overrides:
        itunes_img = channel.find(f"{{{ITUNES_NS}}}image")
        if itunes_img is not None:
            itunes_img.set("href", overrides["image"])
        plain_img = channel.find("image")
        if plain_img is not None:
            url_el = plain_img.find("url")
            if url_el is not None:
                url_el.text = overrides["image"]


@app.route("/feeds/<feed_name>")
def feed(feed_name):
    config = load_config()
    if feed_name not in config.get("feeds", {}):
        abort(404)
    with _cache_lock:
        entry = _feed_cache.get(feed_name)
    if entry:
        return Response(entry["data"], mimetype="application/rss+xml")
    # Cache miss on first request before background refresh completes
    fc = config["feeds"][feed_name]
    source = os.path.expandvars(fc["source"])
    xml_bytes = _fetch_upstream(source)
    overrides = {k: fc[k] for k in ("title", "description", "image") if k in fc}
    return Response(filter_feed(xml_bytes, fc["match"], overrides or None), mimetype="application/rss+xml")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    config = load_config()
    feeds = list(config.get("feeds", {}).keys())
    return jsonify({"feeds": feeds})


# Eager load on startup + start background thread
with app.app_context():
    try:
        refresh_feeds(force=True)
    except Exception:
        log.exception("Initial feed refresh failed")

_refresh_thread = threading.Thread(target=_background_refresh, daemon=True)
_refresh_thread.start()
