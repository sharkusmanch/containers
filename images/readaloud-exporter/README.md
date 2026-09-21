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

| Variable | Required | Description |
|----------|----------|-------------|
| `OUT_DIR` | Yes | Directory the output EPUB and manifest are written to |
| `DB_PATH` | Yes | Path to the alignment-map database/input |

*(Full environment variable reference lands in a later task once the CLI
entrypoint exists.)*

## Output

For each run, writes:

- A read-along EPUB 3 file — the source book with SMIL media overlays and
  embedded Opus audio added, so playback position and text position stay in
  sync.
- A manifest file recording what was produced (inputs used, output path,
  timing/version metadata) for downstream tooling to consume without
  re-parsing the EPUB.

## Modifications from Upstream

Custom application -- no upstream to compare against.
