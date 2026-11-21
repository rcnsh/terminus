die() { echo "$*" >&2; exit 1; }

version() {
  case "$2" in '' | *[!0-9.]*) die "$1: '$2' isn't a version like 1.2.3" ;; esac
  printf '%s\n' "$2" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "$1: '$2' isn't a version like 1.2.3"
}

integrity() {
  if [ "$2" = "$3" ]; then
    printf '%s\n' "$4"
  else
    eval "given=\${$5:-}"
    [ -n "$given" ] || die "$1@$2 isn't the pinned version: set $5 to its integrity (npm view $1@$2 dist.integrity), then pin both in the script"
    printf '%s\n' "$given"
  fi
}

fetch() {
  case "$3" in sha512-*) ;; *) die "$1@$2: expected a sha512- integrity, got '$3'" ;; esac
  file=$(cd "$WORK" && npm pack --silent --ignore-scripts "$1@$2") || die "npm pack $1@$2 failed"
  got="sha512-$(openssl dgst -sha512 -binary "$WORK/$file" | openssl base64 -A)"
  [ "$got" = "$3" ] || die "$1@$2 has integrity $got, expected $3; not unpacking it"
  printf '%s\n' "$WORK/$file"
}

fetch_file() {
  curl -fsSL -o "$WORK/$3" "$1" || die "couldn't download $1"
  got=$(sha256 "$WORK/$3" | cut -d' ' -f1)
  [ "$got" = "$2" ] || die "$1 has SHA-256 $got, expected $2"
  printf '%s\n' "$WORK/$3"
}

sha256() { sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"; }

licence() {
  [ -s "$1" ] || die "no licence at $1: not vendoring without one"
  cp "$1" "$2"
}

record() {
  sums="$OUT/SHA256SUMS"
  touch "$sums"
  keep=$(cat "$sums")
  for p in "$@"; do
    keep=$(printf '%s\n' "$keep" | awk -v p="$p" 'NF && index($2, p) != 1')
  done
  {
    [ -z "$keep" ] || printf '%s\n' "$keep"
    for p in "$@"; do
      (cd "$OUT" && find "$p"* -type f | LC_ALL=C sort | while read -r f; do sha256 "$f"; done)
    done
  } | LC_ALL=C sort -k2 >"$sums.new"
  mv "$sums.new" "$sums"
}
