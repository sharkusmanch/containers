# tachyon

[Tachyon](https://github.com/kimusan/Tachyon) webmail (a maintained fork of SnappyMail),
rebuilt to run unprivileged on a read-only root filesystem, with `gpg` included for
Tachyon's server-side PGP.

## Upstream

- **Repository**: [kimusan/Tachyon](https://github.com/kimusan/Tachyon)
- **Artifact**: the release tarball `tachyon-<version>.tar.gz`, pinned by SHA-256
- **Version**: v4.2.5

## Usage

One image, two containers sharing the pod network: php-fpm and nginx.

```yaml
containers:
  php:     # default command: tachyon-init, then php-fpm on 127.0.0.1:9000
    image: ghcr.io/sharkusmanch/containers/tachyon:v4.2.5
  web:
    image: ghcr.io/sharkusmanch/containers/tachyon:v4.2.5
    command: ["nginx", "-e", "stderr", "-g", "daemon off;"]
```

Runs as UID/GID `10000:10000`. The data volume must be writable by that id (in
Kubernetes, `fsGroup: 10000`).

| Port | Container | Purpose |
|------|-----------|---------|
| 8080 | web | The webmail. Health check: `GET /?/Ping` returns `Pong` (exercises nginx and PHP) |
| 8081 | web | `GET /healthz` for nginx liveness. Keep it out of the Service |
| 9000 | php | FastCGI, bound to 127.0.0.1. Probe with `cgi-fcgi` against `/fpm-ping` |

php liveness probe:

```sh
SCRIPT_NAME=/fpm-ping SCRIPT_FILENAME=/fpm-ping REQUEST_METHOD=GET \
  cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q pong
```

## Volumes

| Path | Container | Description |
|------|-----------|-------------|
| `/var/lib/tachyon` | php | All state: `SALT.php`, configs, domains, per-user settings and PGP keyrings |
| `/tmp` | both | PHP uploads, sessions and cache (see below); nginx temp paths. `emptyDir`, one per container |

## Configuration

Both inputs are optional, read-only mounts in the php container:

| Path | Effect |
|------|--------|
| `/etc/tachyon/overrides.ini` | Linked to `configs/overrides.ini` in the data dir. Tachyon applies it on top of its own `application.ini` on every request and never writes it, so settings stay under your control. Same format as `application.ini`, only the keys you set. |
| `/etc/tachyon/domains/*.json` | The complete list of mail domains users may log in to. Every other domain file is removed at startup, including upstream's wildcard `default.json`, so the app cannot be pointed at arbitrary servers. |

Settings worth putting in `overrides.ini` for this layout:

```ini
[cache]
path = "/tmp/cache"          ; disposable; keeps it off the data volume
[logs]
enable = On
filename = "stderr"          ; to the container log instead of the data volume
[labs]
use_local_proxy_for_external_images = Off  ; else the SERVER fetches remote images
```

## Modifications from Upstream

The application code is unmodified; only the packaging differs.

- **Built from the release tarball, checksum- and signature-verified** against the
  release signing key pinned by fingerprint (`2AF665D5…9866`, expires 2028-09-04: a new
  key means updating `TACHYON_SIGNING_KEY`). A git checkout is never used, since
  version `0.0.0` puts Tachyon in development mode.
- **Alpine's PHP 8.4 packages** instead of compiling extensions into
  `php:8.2-fpm-alpine` (PHP 8.2 leaves security support at the end of 2026). Only the
  extensions Tachyon uses: no gd (so attachment thumbnails must be off), tidy, SQLite,
  LDAP, MySQL, PostgreSQL, Redis or ImageMagick. `allow_url_fopen` is off and unused
  shell functions are disabled; `proc_open`/`shell_exec` stay for gpg.
- **gpg without its network helper.** Only `gpg`, `gpg-agent` and `gpgconf` are
  installed; the `dirmngr` binary (keyserver access), a hard package dependency, is
  deleted.
- **No root, no supervisord.** Upstream's entrypoint chowns the data dir and rewrites
  nginx and PHP config at startup, which requires root. Here config is baked at build
  time and nginx and php-fpm run as separate containers.
- **nginx serves only static assets and the front controller.** Upstream passes any
  existing `.php` file to PHP and serves the whole tree. Here only
  `tachyon/v/<version>/{static,themes}/` is served as files, only `index.php` runs, and
  every other path is routed to it (Tachyon routes on the query string).
- **Two unauthenticated actions are refused** at nginx: `?/Test` (makes the server send
  requests to its own Host header) and `?/AdminAppData` (can write an admin password file).
- **`HTTPS=on` is passed to PHP**, as TLS terminates in front of it, so session cookies
  are marked Secure.
- **A stable `/favicon.ico`**, so an authenticating proxy can exempt one fixed path.
- **`tachyon-init`** prepares the data dir, links the overrides file, enforces the domain
  list, removes stale gpg lock files and agent sockets, and writes a `gpg-agent.conf`
  with passphrase caching disabled into every keyring. Tachyon kills the agent after
  each request, but not if the PHP worker itself is killed mid-request.
