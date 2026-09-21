# readaloud-exporter

Converts an audiobook↔ebook alignment map into an EPUB 3 read-along book: a
standard EPUB augmented with SMIL media overlays and embedded Opus audio, so
a reading app can highlight text in sync with narration and a listener can
jump between text position and audio position.

## Upstream

- **Repository**: Custom application (no upstream)

## Usage

Runs as a one-shot job. Takes an alignment map and the source EPUB/audio as
input and writes a readaloud-augmented EPUB plus a manifest describing what
was produced.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `/data/database.db` | Alignment-map SQLite database (opened read-only). Also supplies the audiobook server URL and API key. |
| `BOOKS_ROOTS` | `/books:/data/epub_cache` | Colon-separated directories searched, in order, for each book's source EPUB |
| `OUT_DIR` | `/out` | Output root; each book is written to `<OUT_DIR>/<audiobook folder name>/` |
| `TMPDIR` | `/tmp` | Scratch space for encoded audio and transcription chunks (removed per book) |
| `WHISPER_ENDPOINTS` | *(none)* | `url\|model,url\|model` — OpenAI-compatible transcription endpoints, tried in order, used only to repair holes and audio-only stretches in the alignment. Every entry needs a non-empty `url` and `model`. Empty is allowed: books that need repair are then `deferred` (`whisper_unavailable`, "no whisper endpoints configured") |
| `EXPORT_ONLY_ABS_IDS` | *(all)* | Comma-separated audiobook item ids to restrict the run to; empty = every eligible book |
| `MAX_BOOKS_PER_RUN` | `3` | Books actually worked on per run: only `ok` and `refused` count (skipped, deferred and errored books do not). Must be a non-negative integer |
| `BITRATE` | `32k` | Opus bitrate for the embedded audio |
| `PATH_MAP` | *(none)* | `src=dst,...` prefix rewrites translating the audiobook server's container paths to this container's mounts |

Entrypoint: `python -m app.main`. At startup it logs one `"event": "config"` line
(version, code hash, whisper endpoints, `only_count`, `max_books`, `out_dir` — no secrets).
Exit code `2` with a `"event": "config_error"` line if the configuration is invalid (a
`WHISPER_ENDPOINTS` entry that is not `url|model`, a non-integer or negative
`MAX_BOOKS_PER_RUN`) or `DB_PATH` is missing; otherwise `0` (per-book failures are
reported, never fatal to the run).

The alignment maps are loaded one book at a time, as each book is processed; selecting
the eligible books reads only their metadata (and applies `EXPORT_ONLY_ABS_IDS` in SQL).

## Output

For each book, in `<OUT_DIR>/<audiobook folder>/`:

- `<ebook stem> (readaloud).epub` — the source book as EPUB 3 with SMIL media
  overlays and embedded Opus audio. Written to a `.part` file, verified, then
  atomically renamed; a refusal never touches an existing good readaloud.
- `.<ebook stem>.readaloud.json` — manifest: input fingerprint, status and
  reason, `exporter_version`, `code_sha256`, gate/verify results, counts
  (fragments, pars, audio files), coverage, output size, timestamp. It is also
  the idempotency state: a book whose fingerprint (exporter version, code hash,
  alignment timestamp, EPUB hash, audio path/size/mtime, bitrate) is unchanged
  and whose last status was `ok` or `refused` is skipped. `code_sha256` is a
  sha256 over the exporter's own `app/*.py` source, so any code change
  re-processes every book, including earlier refusals.
- `.cache/<item id>/` — cached repair transcripts, so a re-run does not
  re-transcribe.

Gap and repair fields in the manifest:

| Field | Meaning |
|-------|---------|
| `holes` / `hole_seconds` | Narrated stretches > 60 s with no anchor, before repair |
| `audio_only_gaps` / `audio_only_seconds` / `audio_only_max_s` | Stretches > 60 s of audio carrying < 0.2× the book's character rate (music, long pauses, or unanchored narration), before repair |
| `repaired_anchors` | Anchors added by re-transcribing holes and audio-only stretches |
| `residual_holes` / `residual_max_hole_s` | Holes left after repair (any ⇒ `unrepaired_hole`) |
| `residual_audio_only` | Audio-only stretches left after repair — recorded, not a refusal |
| `max_par_s` | Longest single overlay clip, in seconds (a large value points at a residual audio-only stretch) |

The run logs one JSON line per book (`"event": "book"`) and a summary line.

### Statuses

| Status | Meaning | Retried next run? |
|--------|---------|-------------------|
| `ok` | Readaloud written and verified | Only if an input changes |
| `refused` | A quality gate failed; nothing (new) published | Only if an input changes |
| `deferred` | A dependency was unavailable (audiobook server, transcription) | Yes |
| `skipped` | Fingerprint unchanged since the last `ok`/`refused` | — |
| `error` | Unexpected, possibly transient exception (reason = exception type) | Yes |

### Refusal reasons

| Reason | Gate |
|--------|------|
| `multi_file_audio` | Audiobook has more than one audio file |
| `epub_not_found` / `audio_not_found` | Source file missing under the configured roots/mounts |
| `fixed_layout` | Book-wide pre-paginated EPUBs (package `<meta property="rendition:layout">pre-paginated</meta>`) are not supported; a per-item spine override in a reflowable book is fine |
| `text_mismatch` | Re-derived reference text length differs from the alignment's (G1) |
| `text_map_mismatch` / `xhtml_parse_error` | Reference text cannot be mapped onto the editable XHTML |
| `id_collision` | A generated fragment id already exists in the source XHTML |
| `nonmonotone_map` / `no_anchors` / `no_rate` | Too many non-monotone anchors dropped (G2), or too few to derive a narration rate |
| `unrepaired_hole` | A narrated stretch > 60 s still has no anchor after repair (G3). Audio-only stretches are repaired the same way but never refused |
| `no_narrated_text` / `no_pars` / `tiling_invariant` | Timing plan could not be tiled gaplessly (G4) |
| `low_coverage` | Less than 99% of narrated text is inside an overlay clip |
| `audio_encode_failed` | ffmpeg/ffprobe failed to encode or measure an audio file |
| `audio_cut_mismatch` | An encoded audio file's length differs from plan by > 0.25 s (G5) |
| `epub_structure` | The source EPUB's structure cannot be rewritten (manifest id/href collision, malformed or incomplete NCX) |
| `verify_failed` | The written EPUB failed independent verification (V0–V6) |

Deferral reasons: `abs_unavailable`, `whisper_unavailable`.

## Modifications from Upstream

Custom application -- no upstream to compare against.
