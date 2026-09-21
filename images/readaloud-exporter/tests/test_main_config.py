"""ABS_SERVER / ABS_TOKEN env-override-database-settings behaviour (main())."""
import json
import sqlite3

from app import main as M


def make_db(path, abs_server="", abs_key=""):
    c = sqlite3.connect(path)
    c.executescript("""
    create table books(abs_id text, abs_title text, ebook_filename text, status text, audio_source text);
    create table book_alignments(abs_id text, alignment_map_json text, last_updated text, align_method text,
                                 total_chars int);
    create table settings(key text, value text);
    """)
    rows = []
    if abs_server:
        rows.append(("ABS_SERVER", abs_server))
    if abs_key:
        rows.append(("ABS_KEY", abs_key))
    if rows:
        c.executemany("insert into settings values (?, ?)", rows)
    c.commit()
    c.close()


def _base_env(monkeypatch, tmp_path, db):
    monkeypatch.setenv("DB_PATH", str(db))
    monkeypatch.setenv("OUT_DIR", str(tmp_path / "out"))
    monkeypatch.delenv("WHISPER_ENDPOINTS", raising=False)
    monkeypatch.delenv("MAX_BOOKS_PER_RUN", raising=False)


def test_abs_env_token_preferred_over_database_settings(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    make_db(db, abs_server="http://db-abs:80", abs_key="db-sekrit")
    _base_env(monkeypatch, tmp_path, db)
    monkeypatch.setenv("ABS_SERVER", "http://env-abs:80")
    monkeypatch.setenv("ABS_TOKEN", "env-sekrit")

    captured = {}

    def fake_run(cfg, db_, abs_client, whisper_client):
        captured["base"] = abs_client.base
        captured["token"] = abs_client.token
        return []

    monkeypatch.setattr(M, "run", fake_run)
    assert M.main() == 0
    assert captured == {"base": "http://env-abs:80", "token": "env-sekrit"}

    out = capsys.readouterr().out
    assert "db-sekrit" not in out and "env-sekrit" not in out
    cfg_line = json.loads(out.strip().splitlines()[0])
    assert cfg_line["event"] == "config"
    assert cfg_line["abs_server"] == "http://env-abs:80"
    assert cfg_line["abs_token_source"] == "env"


def test_abs_database_settings_used_when_env_empty(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    make_db(db, abs_server="http://db-abs:80", abs_key="db-sekrit")
    _base_env(monkeypatch, tmp_path, db)
    monkeypatch.delenv("ABS_SERVER", raising=False)
    monkeypatch.delenv("ABS_TOKEN", raising=False)

    captured = {}

    def fake_run(cfg, db_, abs_client, whisper_client):
        captured["base"] = abs_client.base
        captured["token"] = abs_client.token
        return []

    monkeypatch.setattr(M, "run", fake_run)
    assert M.main() == 0
    assert captured == {"base": "http://db-abs:80", "token": "db-sekrit"}

    out = capsys.readouterr().out
    assert "db-sekrit" not in out
    cfg_line = json.loads(out.strip().splitlines()[0])
    assert cfg_line["event"] == "config"
    assert cfg_line["abs_server"] == "http://db-abs:80"
    assert cfg_line["abs_token_source"] == "database"


def test_abs_empty_token_is_a_config_error(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    make_db(db, abs_server="http://db-abs:80", abs_key="")  # no token anywhere
    _base_env(monkeypatch, tmp_path, db)
    monkeypatch.delenv("ABS_SERVER", raising=False)
    monkeypatch.delenv("ABS_TOKEN", raising=False)

    assert M.main() == 2
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["event"] == "config_error"
    assert "ABS" in line["error"]


def test_abs_empty_server_is_a_config_error(monkeypatch, capsys, tmp_path):
    db = tmp_path / "d.db"
    make_db(db, abs_server="", abs_key="db-sekrit")  # no server anywhere
    _base_env(monkeypatch, tmp_path, db)
    monkeypatch.delenv("ABS_SERVER", raising=False)
    monkeypatch.delenv("ABS_TOKEN", raising=False)

    assert M.main() == 2
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["event"] == "config_error"
    assert "ABS" in line["error"]
