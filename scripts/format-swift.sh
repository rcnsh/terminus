#!/bin/sh
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
