#!/bin/sh
# Tests for ../latest-save. POSIX sh; run by hand with `sh test/latest-save.test.sh`
# or through ../.ci-test. Exits non-zero if any check fails.
here=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${LATEST_SAVE:-$here/../latest-save}
SIZE=23776

work=$(mktemp -d)
trap '[ -n "$bg" ] && kill "$bg" 2>/dev/null; chmod -R u+rwx "$work" 2>/dev/null; rm -rf "$work"' EXIT
trap 'exit 1' INT TERM
bg=
passed=0
failed=0

pass_() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
fail_() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
check() { # description, then a test command
  desc=$1
  shift
  if "$@"; then pass_ "$desc"; else fail_ "$desc"; fi
}

# fresh SAVE_DIR / OUT_DIR for one scenario
fresh() {
  rm -rf "$work/save" "$work/out"
  mkdir -p "$work/save" "$work/out"
  SAVE_DIR=$work/save
  OUT_DIR=$work/out
  export SAVE_DIR OUT_DIR
}

# slot <name> <fill-char> <YYYYMMDDhhmm.ss> [size]: a slot directory holding a save file
slot() {
  mkdir -p "$SAVE_DIR/$1"
  dd if=/dev/zero bs="${4:-$SIZE}" count=1 2>/dev/null | tr '\0' "$2" >"$SAVE_DIR/$1/$1"
  touch -t "$3" "$SAVE_DIR/$1/$1"
}

run() { ONCE=1 sh "$SCRIPT"; }
fill_of() { head -c 1 "$1"; }          # first byte of a file
latest_fill() { fill_of "$OUT_DIR/latest.bin"; }
size_of() { stat -c %s "$1"; }
mt_of() { stat -c %Y "$1"; }
snapshot() { find "$1" -exec stat -c '%n %s %Y' {} \; | sort; }

S=BASLUS-21207dq8

# --- newest file mtime wins, even when a lower slot's directory is newer
fresh
slot ${S}_0 A 202610010000.00
slot ${S}_1 B 202610050000.00
slot ${S}_2 C 202610030000.00
touch -t 202610090000.00 "$SAVE_DIR/${S}_0"   # directory mtime of the OLD slot is the newest
out=$(run)
check "newest file mtime wins over newest directory mtime" test "$(latest_fill)" = B
check "published file is exactly $SIZE bytes" test "$(size_of "$OUT_DIR/latest.bin")" = $SIZE
check "publish logs one line" test "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1
check "log names the slot, not the contents" sh -c 'printf "%s" "$1" | grep -q "published BASLUS-21207dq8_1$" && ! printf "%s" "$1" | grep -q BBBB' _ "$out"

# --- things that must be ignored, even though they are newer
fresh
slot ${S}_1 B 202610010000.00
slot ${S}_6.sync-conflict-20261009-072440-ABCDEFG X 202610090000.00
mkdir -p "$SAVE_DIR/${S}_6.sync-conflict-20261009-072440-ABCDEFG"
slot ${S}_2 W 202610090000.00 $((SIZE - 1))
slot ${S}_3 Z 202610090000.00 $((SIZE + 1))
slot ${S}_x Y 202610090000.00
slot ${S}_4 V 202610090000.00
mv "$SAVE_DIR/${S}_4/${S}_4" "$SAVE_DIR/${S}_4/${S}_4.tmp"            # temp file name only
mkdir -p "$work/elsewhere" "$SAVE_DIR/${S}_5"
dd if=/dev/zero bs=$SIZE count=1 2>/dev/null | tr '\0' U >"$work/elsewhere/newer"
touch -t 202610090000.00 "$work/elsewhere/newer"
ln -s "$work/elsewhere/newer" "$SAVE_DIR/${S}_5/${S}_5"               # symlink to a newer, valid save
mkdir -p "$SAVE_DIR/${S}_7/${S}_7"                                    # directory with the file's name
printf 'x' >"$SAVE_DIR/${S}_8"                                        # plain file with a slot name
mkdir -p "$work/elsewhere/${S}_9"
dd if=/dev/zero bs=$SIZE count=1 2>/dev/null | tr '\0' T >"$work/elsewhere/${S}_9/${S}_9"
touch -t 202610090000.00 "$work/elsewhere/${S}_9/${S}_9"
ln -s "$work/elsewhere/${S}_9" "$SAVE_DIR/${S}_9"                     # symlinked slot directory
run >/dev/null
check "conflict copy, wrong sizes, other names, symlinks and directories are ignored" test "$(latest_fill)" = B

# --- equal mtimes: the higher slot wins (numerically)
fresh
slot ${S}_3 C 202610040000.00
slot ${S}_10 D 202610040000.00
slot ${S}_9 E 202610040000.00
run >/dev/null
check "equal mtimes break ties by the higher slot number (10 beats 9)" test "$(latest_fill)" = D

# --- unchanged content is not rewritten
fresh
slot ${S}_0 A 202610010000.00
run >/dev/null
touch -t 200001010000.00 "$OUT_DIR/latest.bin"
before="$(stat -c '%i %Y' "$OUT_DIR/latest.bin")"
out=$(run)
after="$(stat -c '%i %Y' "$OUT_DIR/latest.bin")"
check "unchanged content: latest.bin keeps inode and mtime" test "$before" = "$after"
check "unchanged pass logs nothing" test -z "$out"
check "no temporary files are left behind" test -z "$(ls -A "$OUT_DIR" | grep '^\.latest\.')"

# --- changed content (same size, same pick) is published
slot ${S}_0 Q 202610010000.00
run >/dev/null
check "changed content of the same slot is republished" test "$(latest_fill)" = Q

# --- a changed pick replaces the file by rename (new inode), never rewrites it in place
fresh
slot ${S}_0 A 202610010000.00
run >/dev/null
ino=$(stat -c %i "$OUT_DIR/latest.bin")
slot ${S}_1 B 202610020000.00
run >/dev/null
check "a new pick replaces latest.bin with a new file" test "$(stat -c %i "$OUT_DIR/latest.bin")" != "$ino"

# --- nothing written inside SAVE_DIR
fresh
slot ${S}_0 A 202610010000.00
slot ${S}_1 B 202610020000.00
before=$(snapshot "$SAVE_DIR")
run >/dev/null
run >/dev/null
after=$(snapshot "$SAVE_DIR")
check "SAVE_DIR is never modified by the script" test "$before" = "$after"

# --- no candidate removes latest.bin
fresh
slot ${S}_0 A 202610010000.00
run >/dev/null
rm -f "$SAVE_DIR/${S}_0/${S}_0"
out=$(run)
check "no candidate removes latest.bin" test ! -e "$OUT_DIR/latest.bin"
check "removal logs one line" test "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1
out=$(run)
check "an empty pass with nothing published logs nothing" test -z "$out"

# --- heartbeat is touched on every pass, including unchanged ones
fresh
slot ${S}_0 A 202610010000.00
run >/dev/null
touch -t 200001010000.00 "$OUT_DIR/heartbeat"
run >/dev/null
check "heartbeat is touched on a pass that changed nothing" test "$(mt_of "$OUT_DIR/heartbeat")" -gt 1000000000
touch -t 200001010000.00 "$OUT_DIR/heartbeat"
rm -f "$SAVE_DIR/${S}_0/${S}_0"
run >/dev/null
check "heartbeat is touched on a pass that removed the save" test "$(mt_of "$OUT_DIR/heartbeat")" -gt 1000000000

# --- a slot that cannot be examined makes the pass change nothing (not a clean "ignore")
if [ "$(id -u)" = 0 ]; then
  printf 'skip unexaminable-slot tests (running as root: chmod does not block access)\n'
else
  fresh
  slot ${S}_0 A 202610010000.00
  slot ${S}_1 B 202610050000.00
  run >/dev/null
  touch -t 200001010000.00 "$OUT_DIR/latest.bin" "$OUT_DIR/heartbeat"
  before="$(stat -c '%i %Y' "$OUT_DIR/latest.bin")"
  chmod 000 "$SAVE_DIR/${S}_1"                   # newest slot becomes unsearchable
  out=$(run)
  chmod 755 "$SAVE_DIR/${S}_1"
  check "unexaminable newest slot: latest.bin is untouched" test "$(stat -c '%i %Y' "$OUT_DIR/latest.bin")" = "$before"
  check "unexaminable newest slot: the older slot is not published" test "$(latest_fill)" = B
  check "unexaminable slot logs one error line" test "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1
  check "unexaminable slot: heartbeat is still touched" test "$(mt_of "$OUT_DIR/heartbeat")" -gt 1000000000

  # nothing published yet: the older slot must not be published either
  fresh
  slot ${S}_0 A 202610010000.00
  slot ${S}_1 B 202610050000.00
  chmod 000 "$SAVE_DIR/${S}_1"
  run >/dev/null
  chmod 755 "$SAVE_DIR/${S}_1"
  check "unexaminable newest slot with nothing published: nothing is published" test ! -e "$OUT_DIR/latest.bin"

  # the only slot is unexaminable: the published save is not removed
  fresh
  slot ${S}_1 B 202610050000.00
  run >/dev/null
  chmod 000 "$SAVE_DIR/${S}_1"
  run >/dev/null
  chmod 755 "$SAVE_DIR/${S}_1"
  check "unexaminable only slot: the published save is not removed" test "$(latest_fill)" = B

  # once the slot is readable again the normal rules apply
  slot ${S}_1 C 202610060000.00
  run >/dev/null
  check "after the slot is readable again, the newest is published" test "$(latest_fill)" = C
fi

# --- start-up validation
unset SAVE_DIR
ONCE=1 OUT_DIR=$work/out sh "$SCRIPT" >/dev/null 2>&1
check "exits non-zero when SAVE_DIR is unset" test $? -ne 0
ONCE=1 OUT_DIR=$work/out SAVE_DIR=$work/does-not-exist sh "$SCRIPT" >/dev/null 2>&1
check "exits non-zero when SAVE_DIR does not exist" test $? -ne 0
: >"$work/plain"
ONCE=1 OUT_DIR=$work/out SAVE_DIR=$work/plain sh "$SCRIPT" >/dev/null 2>&1
check "exits non-zero when SAVE_DIR is not a directory" test $? -ne 0

# --- looping mode: SAVE_DIR disappearing mid-run leaves the published save in place
wait_for() { # seconds, then a predicate command (re-evaluated on every try)
  n=$(($1 * 5))
  shift
  while [ "$n" -gt 0 ]; do
    "$@" && return 0
    sleep 0.2
    n=$((n - 1))
  done
  return 1
}
has_latest() { [ -f "$OUT_DIR/latest.bin" ]; }
latest_is() { [ -f "$OUT_DIR/latest.bin" ] && [ "$(latest_fill)" = "$1" ]; }
heartbeat_fresh() { [ "$(mt_of "$OUT_DIR/heartbeat")" -gt 1000000000 ]; }
stopped() { ! kill -0 "$1" 2>/dev/null; }

fresh
slot ${S}_0 A 202610010000.00
INTERVAL=1 sh "$SCRIPT" >"$work/loop.log" 2>&1 &
bg=$!
check "loop: first pass publishes" wait_for 15 latest_is A
touch -t 200001010000.00 "$OUT_DIR/heartbeat"
check "loop: heartbeat keeps being touched when nothing changes" wait_for 15 heartbeat_fresh
mv "$SAVE_DIR" "$work/save-gone"
touch -t 200001010000.00 "$OUT_DIR/heartbeat"
check "loop: heartbeat is still touched while SAVE_DIR is gone" wait_for 15 heartbeat_fresh
sleep 2.5
check "loop: vanished SAVE_DIR leaves latest.bin in place" latest_is A
check "loop: the failure is logged once, not on every pass" test "$(grep -c 'cannot list' "$work/loop.log")" = 1
mv "$work/save-gone" "$SAVE_DIR"
slot ${S}_1 B 202610020000.00
check "loop: recovers and publishes the newer save" wait_for 15 latest_is B
kill -TERM "$bg"
check "loop: SIGTERM stops the watcher" wait_for 15 stopped "$bg"
bg=

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
