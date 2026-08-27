"""Kindle client: discovery, key emission, fetch, and (narrow) cleanup.

Everything here is reached over SSH/rclone through the Tailscale sidecar's
SOCKS5 proxy. The device is asleep most of the time; unreachable is a normal
state and must never surface as an error.
"""
import logging
import os
import re
import shlex
import shutil
import subprocess
import zipfile
from dataclasses import dataclass

from .identity import asin_of

log = logging.getLogger("kindle-ingest")

ITEMS = "/mnt/us/documents/Downloads/Items01"
TOOL = "/mnt/us/extensions/kfxdedrm"
KEYFILE = "/mnt/us/dedrm/keyfile.txt"
DEDRM_OUT = "/mnt/us/dedrm"
KOREADER = "/mnt/us/koreader"

# What a restore actually needs. Everything here is hand-built state that
# exists nowhere else; fonts, dictionaries and stock plugins are deliberately
# absent because they are re-downloadable and documented.
_BACKUP_PATHS = (
    "settings.reader.lua",
    "history.lua",
    "defaults.custom.lua",
    "settings",
    "patches",
    "styletweaks",
    "plugins/bookorbit.koplugin",
    "plugins/appstore.koplugin",
    "plugins/tailscale.koplugin",   # for its locally patched main.lua
    ".sdrbackup",                   # per-book highlights and positions
)

# Excluded for two different reasons, both load-bearing.
#
# SECRETS: plugins/tailscale.koplugin/bin holds tailscaled.state (the node's
# WireGuard private keys) and auth.key (the Headscale pre-auth key); dropbear_*
# are private SSH host keys. None may reach the backup volume or the offsite
# restic repo. Leaked tailnet identity is worse than a leaked host key.
#
# BULK: that same bin/ is 65MB of re-downloadable Go binaries, restored by its
# own install-tailscale.sh. Caches and .old/.bak.* files are noise that would
# several-fold the archive.
_BACKUP_EXCLUDES = (
    "plugins/tailscale.koplugin/bin",
    "dropbear_*_host_key",
    # The live DBs never enter the archive -- their .dbbk copies do. This also
    # removes the -wal/-shm hazard at the source rather than at restore time.
    "*.sqlite3",
    "*.sqlite3-wal",
    "*.sqlite3-shm",
    "*.old",
    "*.bak.*",
)

# journal_mode=wal on both, and KOReader is usually running, so a plain copy of
# the .sqlite3 can miss everything still in the WAL and restore silently stale.
# .backup is safe against a live writer. The default busy timeout is 0, so
# without .timeout a write in flight fails the whole run.
_BACKUP_DBS = ("statistics", "vocabulary_builder")

# Sidecars are copied here, under their original relative paths.
_SDR_STAGE = f"{KOREADER}/.sdrbackup"

# Deliberately permissive about punctuation real book titles carry
# (apostrophes, commas, #, parentheses, &) and strict about shell
# metacharacters that have no business in a filename.
_UNSAFE = frozenset(["`", "$", "\\", '"', "\n", "\r", "\x00"])


def _unlink_quietly(path: str) -> None:
    """Remove a partial file, tolerating its absence."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _pulled_anything(dest_dir: str) -> bool:
    """Did the pull leave any files? A missing directory answers that: no.

    os.listdir raised FileNotFoundError straight out of fetch_book in the
    cluster, turning a plain transport failure into an unexpected error. The
    directory is created at the top of fetch_book, so its absence here means
    something removed it mid-pull; log that rather than crash on it.
    """
    try:
        return bool(os.listdir(dest_dir))
    except FileNotFoundError:
        log.warning("work dir %s vanished during the pull", dest_dir)
        return False


def _unsafe_name(name: str) -> bool:
    """True if a device filename carries characters we refuse to shell out.

    Deliberately permissive about punctuation real Amazon titles carry --
    apostrophes, commas, '#', parentheses, '&' -- because rejecting those would
    reject books the user owns. Strict about characters that have no business
    in a filename and would be dangerous even quoted.
    """
    return any(c in _UNSAFE for c in name) or not name.strip()

# One round trip: asin|basename|kfx_size|asset_count
LIST_CMD = (
    f'for f in "{ITEMS}"/*.kfx; do '
    '[ -e "$f" ] || continue; '
    'b=$(basename "$f" .kfx); '
    's=$(stat -c%s "$f" 2>/dev/null || echo 0); '
    f'a=$(ls "{ITEMS}/$b.sdr/assets/attachables" 2>/dev/null | wc -l); '
    'printf "%s|%s|%s\\n" "$b" "$s" "$a"; done'
)


class DeviceUnreachable(Exception):
    """Not an error condition -- the device is simply asleep."""


class UnsafeName(Exception):
    """A device filename contained characters we will not pass to a shell.

    Names come from Amazon titles, so apostrophes, commas, hashes and brackets
    are all normal and must be handled -- but a newline, backtick, dollar or
    quote is not, and is refused rather than escaped.
    """


class TruncatedPull(Exception):
    """The transfer did not complete. Retryable, and distinct from a book whose
    Amazon assets were never delivered -- the remedies are opposite."""


@dataclass(frozen=True)
class DeviceBook:
    asin: str
    basename: str
    kfx_size: int
    asset_count: int

    @property
    def kfx_path(self) -> str:
        return f"{ITEMS}/{self.basename}.kfx"

    @property
    def sdr_path(self) -> str:
        return f"{ITEMS}/{self.basename}.sdr"

    @property
    def assets_path(self) -> str:
        return f"{self.sdr_path}/assets"

    @property
    def complete(self) -> bool:
        """False means Amazon never delivered the content containers."""
        return self.asset_count > 0


def parse_book_listing(text: str) -> dict[str, DeviceBook]:
    """Parse the remote listing into {asin: DeviceBook}.

    Entries without an ASIN (jailbreak payloads, font hacks) are dropped.
    """
    out: dict[str, DeviceBook] = {}
    for line in text.splitlines():
        parts = line.strip().split("|")
        if len(parts) != 3:
            continue
        basename, size, assets = parts
        asin = asin_of(basename)
        if not asin:
            continue
        try:
            out[asin] = DeviceBook(asin, basename, int(size), int(assets))
        except ValueError:
            continue
    return out


def build_encrypted_archive(src_dir: str, dest: str) -> str:
    """Flatten a book's encrypted parts into a .kfx-zip.

    The layout the decryptor expects is FLAT: the .kfx, metadata.kfx, voucher
    and every CR!*.kfx attachable at the archive root -- mirroring what the
    on-device tool produces. Written via temp+rename so a killed process never
    leaves a complete-looking archive.
    """
    tmp = dest + ".part"
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    n = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for root, _, files in os.walk(src_dir):
            for fn in files:
                z.write(os.path.join(root, fn), fn)
                n += 1
    if n == 0:
        os.unlink(tmp)
        raise ValueError(f"no files to archive under {src_dir}")
    os.replace(tmp, dest)
    return dest


class Device:
    def __init__(self, cfg):
        self.cfg = cfg

    # --- plumbing -------------------------------------------------------
    def _ssh_base(self) -> list[str]:
        c = self.cfg
        proxy = f"nc -X 5 -x {c.socks_proxy} %h %p"
        return [
            "ssh", "-i", c.ssh_key_path,
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"ConnectTimeout={c.ssh_connect_timeout}",
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "BatchMode=yes",
            "-o", f"ProxyCommand={proxy}",
            "-p", str(c.kindle_port),
            f"root@{c.kindle_host}",
        ]

    def _ssh(self, remote_cmd: str, timeout: int | None = None) -> str:
        p = subprocess.run(
            self._ssh_base() + [remote_cmd],
            capture_output=True, text=True,
            timeout=timeout or self.cfg.rclone_timeout,
        )
        if p.returncode != 0:
            raise DeviceUnreachable(p.stderr.strip()[:200] or f"ssh exit {p.returncode}")
        return p.stdout

    # --- operations -----------------------------------------------------
    def reachable(self) -> bool:
        try:
            self._ssh("echo ok", timeout=self.cfg.ssh_connect_timeout + 10)
            return True
        except (DeviceUnreachable, subprocess.TimeoutExpired, OSError):
            return False

    def list_books(self) -> dict[str, DeviceBook]:
        return parse_book_listing(self._ssh(LIST_CMD))

    def emit_keys(self, timeout: int | None = None) -> None:
        """Run the on-device keyfile mode.

        This writes per-book keys and, importantly, NO decrypted archive --
        the device does the crypto in memory and writes nothing large.
        """
        self._ssh(f"cd {shlex.quote(TOOL)} && bash bin/run_cmd.sh keyfile",
                  timeout=timeout or self.cfg.cycle_deadline)

    def stale_archives(self, books: dict) -> list[str]:
        """Books the device tool will SKIP, emitting no key for them.

        The on-device tool refuses to reprocess a book that already has a
        decrypted archive: "already exists, skipping... Delete it if you want
        to rerun." Leftovers from manual KUAL runs left 19 of 25 books without
        keys, and the only symptom was "Incorrect AES key length (0 bytes)"
        raised much later, in the decryptor. Report the real cause here.

        Only archives whose original is still on the device count -- the rest
        are finished work and none of our concern.
        """
        try:
            listing = self._ssh(f"ls {shlex.quote(DEDRM_OUT)}/*.kfx-zip 2>/dev/null")
        except Exception as e:
            log.debug("could not list %s: %s", DEDRM_OUT, e)
            return []
        have = {b.basename for b in books.values()}
        stale = []
        for line in listing.splitlines():
            name = os.path.basename(line.strip())
            if name.endswith(".kfx-zip") and name[:-len(".kfx-zip")] in have:
                stale.append(name[:-len(".kfx-zip")])
        if stale:
            log.warning(
                "%d book(s) will be skipped by key emission because a decrypted "
                "archive already exists under %s -- delete those to let keys be "
                "emitted: %s", len(stale), DEDRM_OUT, ", ".join(sorted(stale)[:5])
                + (" ..." if len(stale) > 5 else ""))
        return stale

    def clear_keyfile(self) -> None:
        self._ssh(f"rm -f {shlex.quote(KEYFILE)}")

    def _rclone_base(self) -> list[str]:
        c = self.cfg
        return [
            "rclone", "--sftp-host", c.kindle_host, "--sftp-port", str(c.kindle_port),
            "--sftp-user", "root", "--sftp-key-file", c.ssh_key_path,
            "--sftp-shell-type", "unix",
            "--contimeout", "30s", "--timeout", f"{c.rclone_timeout}s",
            "--low-level-retries", "3", "--retries", "2",
        ]

    def fetch_keyfile(self, dest: str) -> str:
        """Pull the whole keyfile. It carries one record per book and SKeyList
        selects by voucher id, so there is no need to demultiplex it."""
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        text = self._ssh(f"cat {shlex.quote(KEYFILE)} 2>/dev/null || true")
        tmp = dest + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, dest)
        return dest

    def fetch_book(self, book: DeviceBook, dest_dir: str) -> str:
        """Pull a book's encrypted parts over ssh, verifying the transfer.

        Uses ssh + tar rather than rclone: rclone's SFTP backend dials TCP
        directly and ignores ALL_PROXY, so it cannot traverse the Tailscale
        sidecar's SOCKS proxy at all, and --sftp-ssh mangles a ProxyCommand
        containing spaces. ssh honours ProxyCommand natively, and one tar
        stream moves the whole book in a single round trip.

        A truncated pull is a TRANSPORT fault -- re-pull immediately. It must
        not be confused with incomplete Amazon assets, whose remedy is the
        opposite (purge the ASIN and re-download).
        """
        if _unsafe_name(book.basename):
            raise UnsafeName(f"refusing to fetch {book.asin}: unexpected characters in {book.basename!r}")
        shutil.rmtree(dest_dir, ignore_errors=True)
        os.makedirs(dest_dir, exist_ok=True)
        kfx = os.path.basename(book.kfx_path)
        # tar takes the assets directory directly. An earlier version built the
        # file list with find piped through sed, interpolating a quoted basename
        # INSIDE a hand-written single-quoted sed expression -- which breaks on
        # any title containing an apostrophe, and this library has several
        # ("The Butcher's Masquerade", "Discount Dan's Backroom Bargains").
        # Every interpolation here is a single shlex.quote'd argument.
        remote = (
            f"cd {shlex.quote(ITEMS)} && "
            f"tar cf - {shlex.quote(kfx)} {shlex.quote(book.basename + '.sdr/assets')} "
            f"2>/dev/null"
        )
        argv = self._ssh_base() + [remote]
        with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
            try:
                tar = subprocess.run(["tar", "xf", "-", "-C", dest_dir],
                                     stdin=p.stdout, capture_output=True,
                                     timeout=self.cfg.pull_timeout)
            except subprocess.TimeoutExpired as e:
                # A transport fault, not an unexpected error: re-pull next
                # cycle. Seen on a several-hundred-MB comic compendium.
                # Kill ssh explicitly: Popen.__exit__ waits with no timeout, so
                # a remote tar stalled on flash behind a healthy link would
                # block here long past the budget we just enforced.
                p.kill()
                raise TruncatedPull(
                    f"{book.asin}: pull exceeded {self.cfg.pull_timeout}s") from e
            finally:
                if p.stdout:
                    p.stdout.close()
            err = (p.stderr.read() or b"").decode(errors="replace")
            rc = p.wait()
        if rc != 0 and not _pulled_anything(dest_dir):
            raise DeviceUnreachable(f"fetch {book.asin}: ssh rc={rc} {err.strip()[:160]}")
        if tar.returncode != 0 and not _pulled_anything(dest_dir):
            raise TruncatedPull(f"{book.asin}: tar failed {tar.stderr[:160]!r}")

        # Count the containers BEFORE flattening, while the on-device layout is
        # still intact. The .kfx is small; these hold the actual content, so a
        # pull that drops them is the truncation worth catching.
        att = os.path.join(dest_dir, book.basename + ".sdr", "assets", "attachables")
        pulled_assets = len(os.listdir(att)) if os.path.isdir(att) else 0

        # Flatten: the archive the decryptor expects has every part at the root.
        for root, _, files in os.walk(dest_dir):
            if root == dest_dir:
                continue
            for fn in files:
                src = os.path.join(root, fn)
                dst = os.path.join(dest_dir, fn)
                if not os.path.exists(dst):
                    shutil.move(src, dst)
        local_kfx = os.path.join(dest_dir, kfx)
        got = os.path.getsize(local_kfx) if os.path.exists(local_kfx) else 0
        if got != book.kfx_size:
            raise TruncatedPull(
                f"{book.asin}: pulled {got} of {book.kfx_size} bytes")
        # Without this a short pull reached the decryptor, which failed with a
        # bare EOFError -- classified DecryptFailed, i.e. TERMINAL, blaming the
        # book for what is a transport fault. Re-pull instead.
        if pulled_assets != book.asset_count:
            raise TruncatedPull(
                f"{book.asin}: pulled {pulled_assets} of {book.asset_count} "
                f"asset containers")
        return dest_dir

    def backup_config(self, dest: str) -> str:
        """Pull KOReader's irreplaceable config and state into a .tar.gz.

        The SQLite databases are captured with `sqlite3 .backup` and land in the
        archive as `settings/<name>.sqlite3.dbbk`. The live .sqlite3/-wal/-shm
        files are excluded outright, so no stale database can ship and there is
        no WAL to replay on restore. Restore strips the suffix:

            for f in settings/*.dbbk; do mv "$f" "${f%.dbbk}"; done
        """
        q = shlex.quote
        # Staging lives INSIDE the koreader tree deliberately. busybox tar's -C
        # is global, not positional as in GNU tar -- verified on device: given
        # `tar cf - fileA -C other fileB`, fileA resolves under `other` and is
        # lost. Every member must therefore share one root, and that root is
        # here.
        stages = [f"{KOREADER}/settings/{db}.sqlite3.dbbk" for db in _BACKUP_DBS]
        rm_stages = "rm -f " + " ".join(q(x) for x in stages)

        # .backup each DB, checking the exit code: a failed .backup that left a
        # stale or absent file to be silently tarred is the exact outcome this
        # routine exists to prevent. .timeout matters because the CLI's default
        # busy timeout is 0 and KOReader is usually holding these open.
        dumps = []
        for db, stage in zip(_BACKUP_DBS, stages):
            live = f"{KOREADER}/settings/{db}.sqlite3"
            dumps.append(
                f"if [ -f {q(live)} ]; then "
                f"sqlite3 -cmd '.timeout 5000' {q(live)} \".backup {stage}\" "
                f"|| {{ {rm_stages}; exit 91; }}; fi"
            )
        excludes = " ".join(f"--exclude={q(e)}" for e in _BACKUP_EXCLUDES)

        # Per-book sidecars hold reading position, bookmarks and highlights and
        # live NEXT TO each book, outside this tree -- unreachable from a
        # single-root tar. Copy them in under their original relative paths so a
        # restore knows where they belong. A few KB.
        sdr = (
            f"rm -rf {q(_SDR_STAGE)}; mkdir -p {q(_SDR_STAGE)}; "
            f"find /mnt/us -name 'metadata.*.lua' ! -path {q(KOREADER + '/*')} "
            f"2>/dev/null | while read -r f; do "
            f'd="{_SDR_STAGE}/$(dirname "${{f#/mnt/us/}}")"; '
            f'mkdir -p "$d" && cp "$f" "$d/" || true; done'
        )

        # No `set -e`. It would skip the cleanup on every failing path, leaving
        # .dbbk files inside KOReader's live settings directory, and a leftover
        # stage could then be tarred as fresh on a later run. Errors are handled
        # explicitly instead, and the run starts by clearing any stale stage.
        remote = "; ".join([
            rm_stages,
            # Degrade rather than fail: without sqlite3 the ~290KB of Lua config
            # is still worth capturing.
            f"if command -v sqlite3 >/dev/null 2>&1; then {'; '.join(dumps)}; fi",
            sdr,
            f"cd {q(KOREADER)} || {{ {rm_stages}; exit 92; }}",
            # A path that has gone missing (an uninstalled plugin) must not fail
            # the whole backup forever.
            "set --",
            "for p in " + " ".join(q(x) for x in _BACKUP_PATHS)
            + '; do [ -e "$p" ] && set -- "$@" "$p"; done',
            f'[ $# -gt 0 ] || {{ {rm_stages}; exit 93; }}',
            f'tar czf - {excludes} "$@"',
            "rc=$?",
            rm_stages,
            f"rm -rf {q(_SDR_STAGE)}",
            "exit $rc",
        ])
        argv = self._ssh_base() + [remote]
        tmp_dest = dest + ".part"
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        with open(tmp_dest, "wb") as out:
            with subprocess.Popen(argv, stdout=out, stderr=subprocess.PIPE) as p:
                try:
                    _, err = p.communicate(timeout=self.cfg.backup_timeout)
                except subprocess.TimeoutExpired as e:
                    p.kill()
                    _unlink_quietly(tmp_dest)
                    raise TruncatedPull(
                        f"config backup exceeded {self.cfg.backup_timeout}s") from e
                rc = p.returncode
        if rc != 0:
            _unlink_quietly(tmp_dest)
            msg = (err or b"").decode(errors="replace").strip()[:200]
            # 255 is ssh's own "could not connect" -- a sleeping Kindle, which
            # the caller treats as normal rather than as a broken transfer.
            if rc == 255:
                raise DeviceUnreachable(f"config backup: {msg}")
            raise TruncatedPull(f"config backup: rc={rc} {msg}")
        return tmp_dest

    def build_archive(self, src_dir: str, dest: str) -> str:
        return build_encrypted_archive(src_dir, dest)

    def delete_book(self, book: DeviceBook) -> list[str]:
        """Remove the encrypted source ONLY.

        Deletes the .kfx, the assets/ subtree, and the decrypted .kfx-zip the
        on-device tool wrote for this book. The .sdr directory itself is
        preserved: it holds reading position, bookmarks and highlights, and
        destroying it would silently discard reading history.

        The decrypted archive is included because nothing else ever removes it.
        They accumulated to 339MB, and a leftover archive additionally makes
        the tool SKIP that book on the next keyfile run and emit no key for it
        -- the cause of key emission covering 6 of 25 books.
        """
        targets = [book.kfx_path, book.assets_path,
                   f"{DEDRM_OUT}/{book.basename}.kfx-zip"]
        self._ssh(" && ".join(f"rm -rf {shlex.quote(t)}" for t in targets))
        return targets
