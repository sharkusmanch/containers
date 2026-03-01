import os
import re
import time

import requests
import yaml
from flask import Flask, Response, abort, jsonify
from lxml import etree

app = Flask(__name__)

CONFIG_PATH = os.environ.get("CONFIG_PATH", "/config/config.yaml")

_cache = {}


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def get_feed(url, ttl):
    now = time.time()
    cached = _cache.get(url)
    if cached and now - cached["time"] < ttl:
        return cached["data"]
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    _cache[url] = {"data": resp.content, "time": now}
    return resp.content


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
        itunes_name = channel.find(f"{{{ITUNES_NS}}}author")
        if itunes_name is not None:
            itunes_name.text = overrides["title"]
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
    feed_config = config.get("feeds", {}).get(feed_name)
    if not feed_config:
        abort(404)
    ttl = config.get("cache_ttl", 300)
    source = os.path.expandvars(feed_config["source"])
    xml_bytes = get_feed(source, ttl)
    overrides = {}
    for key in ("title", "description", "image"):
        if key in feed_config:
            overrides[key] = feed_config[key]
    filtered = filter_feed(xml_bytes, feed_config["match"], overrides or None)
    return Response(filtered, mimetype="application/rss+xml")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    config = load_config()
    feeds = list(config.get("feeds", {}).keys())
    return jsonify({"feeds": feeds})
