#!/usr/bin/env bash
# Motion conformance checks for the UI source:
#  1. `transition: all` is forbidden — every transition names its properties.
#  2. Layout-affecting properties are never transitioned; animate transform/opacity.
#  3. Durations come from --je-duration-* tokens; raw ms/s values live only in tokens.css.
set -euo pipefail
cd "$(dirname "$0")/.."

src="apps/web/src"
fail=0

# Flatten each file so multi-line transition declarations are checked as one unit.
transitions="$(
  find "$src" \( -name '*.css' -o -name '*.svelte' \) -type f | while read -r file; do
    tr '\n' ' ' <"$file" | grep -oE 'transition:[^;{}]*' | sed "s|^|$file: |" || true
  done
)"

if printf '%s\n' "$transitions" | grep -E 'transition: *all\b' >/dev/null; then
  echo 'FAIL: `transition: all` is forbidden — name the transitioned properties.'
  printf '%s\n' "$transitions" | grep -E 'transition: *all\b'
  fail=1
fi

if printf '%s\n' "$transitions" |
  grep -E '(^| )(width|height|margin(-[a-z]+)?|padding(-[a-z]+)?|top|left|right|bottom|inset|flex-basis|gap|font-size) ' >/dev/null; then
  echo 'FAIL: layout-affecting properties must not be transitioned — use transform/opacity.'
  printf '%s\n' "$transitions" |
    grep -E '(^| )(width|height|margin(-[a-z]+)?|padding(-[a-z]+)?|top|left|right|bottom|inset|flex-basis|gap|font-size) '
  fail=1
fi

raw_durations="$(
  grep -rnE '(transition|animation)[^;:]*:[^;]*[0-9]+(\.[0-9]+)?m?s\b' "$src" \
    --include='*.css' --include='*.svelte' |
    grep -v 'ui/styles/tokens.css' || true
)"
if [ -n "$raw_durations" ]; then
  echo 'FAIL: raw animation/transition durations outside tokens.css — use --je-duration-* tokens.'
  printf '%s\n' "$raw_durations"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo 'motion checks passed'
fi
exit "$fail"
