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

# Deliberately permissive about punctuation real book titles carry
# (apostrophes, commas, #, parentheses, &) and strict about shell
# metacharacters that have no business in a filename.
_UNSAFE = frozenset(["`", "$", "\\", '"', "\n", "\r", "\x00"])


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
        return dest_dir

    def build_archive(self, src_dir: str, dest: str) -> str:
        return build_encrypted_archive(src_dir, dest)

    def delete_book(self, book: DeviceBook) -> list[str]:
        """Remove the encrypted source ONLY.

        Deletes the .kfx and the assets/ subtree. The .sdr directory itself is
        preserved: it holds reading position, bookmarks and highlights, and
        destroying it would silently discard reading history.
        """
        targets = [book.kfx_path, book.assets_path]
        self._ssh(" && ".join(f"rm -rf {shlex.quote(t)}" for t in targets))
        return targets
