#!/bin/sh

set -eu

repository_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"

if [ ! -d "${repository_root}/.git" ]; then
  echo "Public boundary check requires a Git worktree: ${repository_root}" >&2
  exit 1
fi

tracked_existing_paths() {
  git -C "${repository_root}" ls-files -- "$@" | while IFS= read -r path; do
    if [ -e "${repository_root}/${path}" ] || [ -L "${repository_root}/${path}" ]; then
      printf '%s\n' "${path}"
    fi
  done
}

tracked_private_paths="$(
  tracked_existing_paths \
    'AGENTS.md' \
    'apps/web/build' \
    'apps/web/build/**' \
    'apps/web/static/reviews' \
    'apps/web/static/reviews/**' \
    'apps/web/tests/private' \
    'apps/web/tests/private/**' \
    'skills' \
    'skills/**'
)"

if [ -n "${tracked_private_paths}" ]; then
  echo "Refusing to publish private or generated paths:" >&2
  printf '%s\n' "${tracked_private_paths}" >&2
  exit 1
fi

# Public prose is product-facing. Architecture records, implementation guides, agent
# instructions, internal reviews, and other development-process documents belong in
# the sibling private repository. Add a path here only when it is genuinely needed by
# users, installers, operators, integrators, releases, or security reporters.
unexpected_public_docs="$(
  tracked_existing_paths '*.md' 'docs/**' | awk '
    $0 == "README.md" ||
    $0 == "CHANGELOG.md" ||
    $0 == "SECURITY.md" ||
    $0 == "TRADEMARKS.md" ||
    $0 == "CODE_OF_CONDUCT.md" { next }
    $0 ~ /^docs\/(user|installation|operator|integration|reference|releases|security)\// { next }
    { print }
  '
)"

if [ -n "${unexpected_public_docs}" ]; then
  echo "Refusing to publish development-process documentation:" >&2
  printf '%s\n' "${unexpected_public_docs}" >&2
  echo "Move it to the private repository or split out a user/operator/reference document." >&2
  exit 1
fi

echo "Public repository boundary is clean."
