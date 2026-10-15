#!/bin/sh
# Formats every Swift file in the repo with swift-format (the one in the
# Xcode toolchain, `swift format`), by the root .swift-format.
#
#   scripts/format-swift.sh           # rewrite the files in place
#   scripts/format-swift.sh --check   # list the files it would change; exit 1 if any
set -eu

cd "$(git rev-parse --show-toplevel)"

case ${1:-} in
  '')
    git ls-files -z '*.swift' | xargs -0 swift format format --in-place --parallel
    ;;
  --check)
    status=0
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    for f in $(git ls-files '*.swift'); do
      swift format format "$f" > "$tmp"
      if ! cmp -s "$f" "$tmp"; then
        echo "$f"
        status=1
      fi
    done
    [ "$status" -eq 0 ] || echo "Not formatted: run scripts/format-swift.sh" >&2
    exit "$status"
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac
