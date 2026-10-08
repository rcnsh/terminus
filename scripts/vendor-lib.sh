# Checks and steps shared by scripts/vendor-preact.sh, vendor-map.sh and
# vendor-mediabunny.sh, which source this file from the repo root after
# setting OUT (apps/web/public/vendor) and WORK (their temporary folder).

die() { echo "$*" >&2; exit 1; }

# A version as npm publishes a release: 1.2.3, nothing else. It goes into a
# package spec, a file name and a folder name, so nothing odd may get through.
version() {
  printf '%s\n' "$2" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "$1: '$2' isn't a version like 1.2.3"
}

# The tarball's npm integrity ("sha512-…", as `npm view <pkg>@<version>
# dist.integrity` prints it) for the version asked for: the pinned one's is
# in the script; any other version's must be passed in the environment
# variable named, looked up by the person updating, never taken from the
# registry that serves the tarball.
#   integrity <name> <version> <pinned-version> <pinned-integrity> <env-var>
integrity() {
  if [ "$2" = "$3" ]; then
    printf '%s\n' "$4"
  else
    eval "given=\${$5:-}"
    [ -n "$given" ] || die "$1@$2 isn't the pinned version: set $5 to its integrity (npm view $1@$2 dist.integrity), then pin both in the script"
    printf '%s\n' "$given"
  fi
}

# Downloads <name>@<version> from npm into $WORK and checks it against its
# integrity before anything is unpacked. npm checks the tarball against the
# registry's own record; this checks it against ours, so a version that was
# changed or republished upstream stops here.
#   fetch <name> <version> <integrity>   (prints the tarball's path)
fetch() {
  case "$3" in sha512-*) ;; *) die "$1@$2: expected a sha512- integrity, got '$3'" ;; esac
  file=$(cd "$WORK" && npm pack --silent --ignore-scripts "$1@$2") || die "npm pack $1@$2 failed"
  got="sha512-$(openssl dgst -sha512 -binary "$WORK/$file" | openssl base64 -A)"
  [ "$got" = "$3" ] || die "$1@$2 has integrity $got, expected $3; not unpacking it"
  printf '%s\n' "$WORK/$file"
}

# Downloads a file from a pinned URL into $WORK and checks its SHA-256.
#   fetch_file <url> <sha256> <name>   (prints the file's path)
fetch_file() {
  curl -fsSL -o "$WORK/$3" "$1" || die "couldn't download $1"
  got=$(sha256 "$WORK/$3" | cut -d' ' -f1)
  [ "$got" = "$2" ] || die "$1 has SHA-256 $got, expected $2"
  printf '%s\n' "$WORK/$3"
}

sha256() { sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"; }

# Copies a licence that must be there: a library is never vendored without it.
#   licence <from> <to>
licence() {
  [ -s "$1" ] || die "no licence at $1: not vendoring without one"
  cp "$1" "$2"
}

# Rewrites the entries of vendor/SHA256SUMS for the folders whose names start
# with each prefix given, from the files now in them. The rest of the file is
# kept. test/vendor.test.js (apps/api) fails when a file under vendor/ doesn't
# match it, so a vendored file can't change unnoticed.
#   record <prefix>...
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
