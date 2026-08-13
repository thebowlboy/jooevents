#!/bin/sh

set -eu

build_root="apps/web/build"

if [ ! -d "${build_root}" ]; then
  echo "Demo build check failed: ${build_root} does not exist." >&2
  exit 1
fi

review_artifacts="$(find "${build_root}" -type f -path '*/reviews/*' -print)"
if [ -n "${review_artifacts}" ]; then
  echo "Demo build check failed: review artifacts entered the release bundle:" >&2
  printf '%s\n' "${review_artifacts}" >&2
  exit 1
fi

echo "Demo build artifact contains no review files."
