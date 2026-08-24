import pytest
import zipfile
from app.device import parse_book_listing, build_encrypted_archive, DeviceBook

LISTING = """Jade City (The Green Bone Saga Book 1)_B06XRCBRX8|532480|2
Onyx Storm (The Empyrean Book 3)_B0CW1FKFB9|687633|0
cs-5.19.5-jb|1234|0
The Walking Dead #151_B01B1YHS9Y|16000|3"""


def test_parses_listing_keyed_by_asin():
    b = parse_book_listing(LISTING)
    assert set(b) == {"B06XRCBRX8", "B0CW1FKFB9", "B01B1YHS9Y"}   # jailbreak payload dropped


def test_sizes_and_asset_counts():
    b = parse_book_listing(LISTING)
    assert b["B06XRCBRX8"].kfx_size == 532480
    assert b["B06XRCBRX8"].asset_count == 2


def test_zero_assets_marks_book_incomplete():
    b = parse_book_listing(LISTING)
    assert b["B0CW1FKFB9"].complete is False
    assert b["B06XRCBRX8"].complete is True


def test_malformed_lines_ignored():
    assert parse_book_listing("garbage\n\n|||\nx|y") == {}


def test_paths_derive_from_basename():
    b = parse_book_listing(LISTING)["B06XRCBRX8"]
    assert b.kfx_path.endswith("_B06XRCBRX8.kfx")
    assert b.sdr_path.endswith("_B06XRCBRX8.sdr")
    assert b.assets_path.endswith("_B06XRCBRX8.sdr/assets")


def test_build_encrypted_archive_is_flat(tmp_path):
    src = tmp_path / "src"
    (src / "assets" / "attachables").mkdir(parents=True)
    (src / "Book_B0TEST12345.kfx").write_bytes(b"kfx")
    (src / "assets" / "metadata.kfx").write_bytes(b"meta")
    (src / "assets" / "voucher").write_bytes(b"vouch")
    (src / "assets" / "attachables" / "CR!AAA.kfx").write_bytes(b"cr")
    out = build_encrypted_archive(str(src), str(tmp_path / "out.kfx-zip"))
    assert sorted(zipfile.ZipFile(out).namelist()) == [
        "Book_B0TEST12345.kfx", "CR!AAA.kfx", "metadata.kfx", "voucher"]


def test_build_encrypted_archive_leaves_no_partial(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.kfx").write_bytes(b"x")
    out = build_encrypted_archive(str(src), str(tmp_path / "o.kfx-zip"))
    assert not (tmp_path / "o.kfx-zip.part").exists()


def test_empty_source_refuses_rather_than_writing_empty_archive(tmp_path):
    src = tmp_path / "empty"
    src.mkdir()
    with pytest.raises(ValueError):
        build_encrypted_archive(str(src), str(tmp_path / "o.kfx-zip"))
    assert not (tmp_path / "o.kfx-zip").exists()


def test_delete_targets_never_include_the_sdr_itself():
    b = DeviceBook("B0TEST12345", "Book_B0TEST12345", 100, 2)
    targets = [b.kfx_path, b.assets_path]
    assert not any(t.endswith(".sdr") for t in targets)   # .sdr is reading history
    assert any(t.endswith(".sdr/assets") for t in targets)


# --- regressions for the shell-injection finding ---------------------------

def test_real_apostrophe_titles_are_accepted():
    """Rejecting these would reject books the user actually owns."""
    from app.device import _unsafe_name
    for n in ["The Butcher's Masquerade_ DCC Book 5_B09R6C5X88",
              "Cul-de-sac Carnage _ (Discount Dan's Backroom Bargains Book 2)_B0DZXSB9L3",
              "The Walking Dead #151_B01B1YHS9Y",
              "A Parade of Horribles_ DCC, Book 8_B0GJJDXG4L",
              "Exodus_ The Helium Sea (Book 2)_B0FRFPWXMF"]:
        assert not _unsafe_name(n), n


def test_shell_metacharacters_are_refused_not_escaped():
    from app.device import _unsafe_name
    for n in ["evil`whoami`", "x$(id)", 'a"b', "line\nbreak", "back\\slash", "", "   "]:
        assert _unsafe_name(n), n


def test_fetch_book_refuses_an_unsafe_basename(tmp_path):
    from app.device import Device, DeviceBook, UnsafeName
    class Cfg:
        kindle_host="h"; kindle_port=2222; ssh_key_path="/k"; socks_proxy="p:1"
        ssh_connect_timeout=5; rclone_timeout=5
    b = DeviceBook("B0TEST1234", "evil`whoami`_B0TEST1234", 10, 2)
    with pytest.raises(UnsafeName):
        Device(Cfg()).fetch_book(b, str(tmp_path / "d"))


# --- a big comic must not be cut off mid-pull -------------------------------
# Observed in the cluster: "Invincible Compendium Vol. 1" is hundreds of MB and
# the pull died at rclone_timeout + 120 = 420s. The link runs ~1 MB/s through
# the Tailscale DERP relay, so 420s caps a book at roughly 400 MB.

class _Cfg:
    kindle_host = "h"; kindle_port = 2222; ssh_key_path = "/k"; socks_proxy = "p:1"
    ssh_connect_timeout = 5; rclone_timeout = 300; pull_timeout = 3600


def test_pull_timeout_is_generous_enough_for_a_large_comic(monkeypatch, tmp_path):
    import subprocess
    from app.device import Device, DeviceBook
    seen = {}

    class FakeProc:
        stdout = None
        stderr = type("E", (), {"read": staticmethod(lambda: b"")})()
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def wait(self): return 0

    def fake_run(argv, **kw):
        seen["timeout"] = kw.get("timeout")
        d = tmp_path / "d"
        # the post-pull checks compare against book.kfx_size AND asset_count
        att = d / "Title_B0TEST1234.sdr" / "assets" / "attachables"
        att.mkdir(parents=True, exist_ok=True)
        (d / "Title_B0TEST1234.kfx").write_bytes(b"x" * 10)
        for i in range(2):
            (att / f"CR!A{i}.kfx").write_bytes(b"a")
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(subprocess, "run", fake_run)
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 2)
    Device(_Cfg()).fetch_book(b, str(tmp_path / "d"))
    assert seen["timeout"] == 3600           # not rclone_timeout + 120


def test_a_pull_that_times_out_is_a_transport_fault(monkeypatch, tmp_path):
    # It was surfacing as a bare TimeoutExpired, which _process could only treat
    # as an unexpected error. It is a transport fault: re-pull next cycle.
    import subprocess
    from app.device import Device, DeviceBook, TruncatedPull

    class FakeProc:
        stdout = None
        stderr = type("E", (), {"read": staticmethod(lambda: b"")})()
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def wait(self): return 0
        def kill(self): pass

    def boom(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw.get("timeout", 1))

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(subprocess, "run", boom)
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 2)
    with pytest.raises(TruncatedPull):
        Device(_Cfg()).fetch_book(b, str(tmp_path / "d2"))


# --- a vanished work dir means "pulled nothing", not a crash ----------------
# Seen in the cluster: os.listdir raised FileNotFoundError from fetch_book and
# the book was recorded as an unexpected error. The question being asked is
# "did we get any files?" -- a missing directory answers that plainly.

def test_missing_dest_dir_is_reported_as_a_transport_fault(monkeypatch, tmp_path):
    import subprocess
    from app.device import Device, DeviceBook, DeviceUnreachable

    class FakeProc:
        stdout = None
        stderr = type("E", (), {"read": staticmethod(lambda: b"")})()
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def wait(self): return 255            # ssh failed

    def run_and_remove(argv, **kw):
        # whatever removed it in production, the check must survive it
        import shutil as sh
        sh.rmtree(tmp_path / "gone", ignore_errors=True)
        return subprocess.CompletedProcess(argv, 2, b"", b"not a tar archive")

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(subprocess, "run", run_and_remove)
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 2)
    with pytest.raises(DeviceUnreachable):        # not FileNotFoundError
        Device(_Cfg()).fetch_book(b, str(tmp_path / "gone"))


def test_a_timed_out_pull_kills_the_ssh_child(monkeypatch, tmp_path):
    # Popen.__exit__ waits with no timeout and no kill, so a remote tar that
    # stalls while the link stays healthy would block the pod past its budget.
    import subprocess
    from app.device import Device, DeviceBook, TruncatedPull
    killed = []

    class FakeProc:
        stdout = None
        stderr = type("E", (), {"read": staticmethod(lambda: b"")})()
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def wait(self): return 0
        def kill(self): killed.append(True)

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(subprocess, "run",
                        lambda argv, **kw: (_ for _ in ()).throw(
                            subprocess.TimeoutExpired(argv, 1)))
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 2)
    with pytest.raises(TruncatedPull):
        Device(_Cfg()).fetch_book(b, str(tmp_path / "d3"))
    assert killed, "ssh child must be killed, not waited on indefinitely"


# --- the assets are the payload; verify them, not just the .kfx -------------
# fetch_book checked only the main .kfx size, which is tiny next to the asset
# containers holding the actual content. A pull that dropped containers passed
# verification and then died in the decryptor with a bare EOFError, which
# _process records as DecryptFailed -> FAILED, terminal. Observed on
# "Invincible Compendium Vol. 1" after a 400MB+ transfer.

def _fake_pull(tmp_path, monkeypatch, basename, kfx_size, n_assets):
    """Stand in for ssh+tar, laying down the on-device layout."""
    import subprocess
    dest = tmp_path / "d"

    class FakeProc:
        stdout = None
        stderr = type("E", (), {"read": staticmethod(lambda: b"")})()
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def wait(self): return 0
        def kill(self): pass

    def fake_run(argv, **kw):
        att = dest / f"{basename}.sdr" / "assets" / "attachables"
        att.mkdir(parents=True, exist_ok=True)
        (dest / f"{basename}.kfx").write_bytes(b"x" * kfx_size)
        for i in range(n_assets):
            (att / f"CR!ASSET{i:03d}.kfx").write_bytes(b"a" * 4)
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(subprocess, "run", fake_run)
    return str(dest)


def test_a_pull_missing_asset_containers_is_truncated_not_corrupt(monkeypatch, tmp_path):
    from app.device import Device, DeviceBook, TruncatedPull
    dest = _fake_pull(tmp_path, monkeypatch, "Title_B0TEST1234", 10, n_assets=3)
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 5)   # device says 5
    with pytest.raises(TruncatedPull) as e:
        Device(_Cfg()).fetch_book(b, dest)
    assert "3" in str(e.value) and "5" in str(e.value)


def test_a_complete_pull_passes_asset_verification(monkeypatch, tmp_path):
    from app.device import Device, DeviceBook
    dest = _fake_pull(tmp_path, monkeypatch, "Title_B0TEST1234", 10, n_assets=5)
    b = DeviceBook("B0TEST1234", "Title_B0TEST1234", 10, 5)
    assert Device(_Cfg()).fetch_book(b, dest) == dest
