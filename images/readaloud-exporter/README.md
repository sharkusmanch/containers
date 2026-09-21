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
| `WHISPER_ENDPOINTS` | *(none)* | `url\|model,url\|model` — OpenAI-compatible transcription endpoints, tried in order, used only to repair holes in the alignment |
| `EXPORT_ONLY_ABS_IDS` | *(all)* | Comma-separated audiobook item ids to restrict the run to; empty = every eligible book |
| `MAX_BOOKS_PER_RUN` | `3` | Books actually worked on per run (skipped books do not count) |
| `BITRATE` | `32k` | Opus bitrate for the embedded audio |
| `PATH_MAP` | *(none)* | `src=dst,...` prefix rewrites translating the audiobook server's container paths to this container's mounts |

Entrypoint: `python -m app.main`. Exit code `2` if `DB_PATH` is missing, otherwise `0`
(per-book failures are reported, never fatal to the run).

## Output

For each book, in `<OUT_DIR>/<audiobook folder>/`:

- `<ebook stem> (readaloud).epub` — the source book as EPUB 3 with SMIL media
  overlays and embedded Opus audio. Written to a `.part` file, verified, then
  atomically renamed; a refusal never touches an existing good readaloud.
- `.<ebook stem>.readaloud.json` — manifest: input fingerprint, status and
  reason, gate/verify results, counts (fragments, pars, audio files), coverage,
  output size, timestamp. It is also the idempotency state: a book whose
  fingerprint (exporter version, alignment timestamp, EPUB hash, audio
  path/size/mtime, bitrate) is unchanged and whose last status was `ok` or
  `refused` is skipped.
- `.cache/<item id>/` — cached hole transcripts, so a re-run does not
  re-transcribe.

The run logs one JSON line per book (`"event": "book"`) and a summary line.

### Statuses

| Status | Meaning | Retried next run? |
|--------|---------|-------------------|
| `ok` | Readaloud written and verified | Only if an input changes |
| `refused` | A quality gate failed; nothing (new) published | Only if an input changes |
| `deferred` | A dependency was unavailable (audiobook server, transcription) | Yes |
| `skipped` | Fingerprint unchanged since the last `ok`/`refused` | — |
| `error` | Unexpected exception (reason = exception type) | Yes |

### Refusal reasons

| Reason | Gate |
|--------|------|
| `multi_file_audio` | Audiobook has more than one audio file |
| `epub_not_found` / `audio_not_found` | Source file missing under the configured roots/mounts |
| `fixed_layout` | Pre-paginated EPUBs are not supported |
| `text_mismatch` | Re-derived reference text length differs from the alignment's (G1) |
| `text_map_mismatch` / `xhtml_parse_error` | Reference text cannot be mapped onto the editable XHTML |
| `id_collision` | A generated fragment id already exists in the source XHTML |
| `nonmonotone_map` / `no_anchors` / `no_rate` | Too many non-monotone anchors dropped (G2), or too few to derive a narration rate |
| `unrepaired_hole` | A narrated stretch > 60 s still has no anchor after repair (G3) |
| `no_narrated_text` / `no_pars` / `tiling_invariant` | Timing plan could not be tiled gaplessly (G4) |
| `low_coverage` | Less than 99% of narrated text is inside an overlay clip |
| `audio_cut_mismatch` | An encoded audio file's length differs from plan by > 0.25 s (G5) |
| `verify_failed` | The written EPUB failed independent verification (V0–V6) |

Deferral reasons: `abs_unavailable`, `whisper_unavailable`.

## Modifications from Upstream

Custom application -- no upstream to compare against.
