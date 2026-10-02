#!/bin/sh
# Sets up a Linux VPS (Debian or Ubuntu, x86_64) to deploy the Worker and
# run scripts/release.sh, so a release can be done over SSH from a phone.
# The Mac app still builds in GitHub Actions from the tag, as from the Mac.
#
#   git clone https://github.com/rcnsh/terminus && cd terminus
#   scripts/vps-setup.sh        # as your normal user; asks for sudo once
#
# Safe to run again: it skips what's already there, and finishes with a
# list of what's still missing. It installs:
#   - git, curl, unzip, Python 3 and Java 21 (apt)
#   - Node 24 and pnpm in ~/.local/node
#   - the Android SDK in ~/android-sdk, with its licences accepted (Gradle
#     downloads the platform and build tools it needs on the first build)
#   - 4 GB of swap when the machine has under 6 GB of RAM and no swap
#     (the Android build wants about 4 GB)
#   - the repo's packages (pnpm install)
# and writes ~/.terminus/env (only you can read it) for the Cloudflare
# token, loaded by ~/.profile.
#
# Then, from the Mac, copy the keys over (they never go on GitHub):
#   scp ~/.gradle/gradle.properties vps:.gradle/        # the TERMINUS_* lines
#   scp <the keystore it names> vps:<the same path, or edit the line>
#   scp apps/android/app/google-services.json vps:terminus/apps/android/app/
# and put a Cloudflare API token in ~/.terminus/env on the VPS.
#
# A release from the VPS:
#   git pull && pnpm install
#   (cd apps/api && pnpm run deploy)
#   scripts/release.sh --dry-run && scripts/release.sh
#   git push origin main v<version>
# then upload build/release/<version>/terminus-<version>.aab in Play Console.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

[ "$(uname -s)" = Linux ] || { echo "this is for a Linux VPS; on a Mac, see CONTRIBUTING.md"; exit 1; }
# Android's build tools (aapt2) only ship for x86_64 Linux.
[ "$(uname -m)" = x86_64 ] || { echo "needs an x86_64 VPS: Android's build tools don't run on $(uname -m) Linux"; exit 1; }
command -v apt-get >/dev/null || { echo "needs Debian or Ubuntu (apt-get)"; exit 1; }
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO=sudo

echo "== packages"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl unzip xz-utils python3 openjdk-21-jdk-headless >/dev/null
echo "git, curl, python3, java 21"

PROFILE_LINES='
# terminus (scripts/vps-setup.sh)
export PATH="$HOME/.local/node/bin:$HOME/android-sdk/cmdline-tools/latest/bin:$HOME/android-sdk/platform-tools:$PATH"
export ANDROID_HOME="$HOME/android-sdk"
[ -f "$HOME/.terminus/env" ] && . "$HOME/.terminus/env"'
if ! grep -q "scripts/vps-setup.sh" "$HOME/.profile" 2>/dev/null; then
  printf '%s\n' "$PROFILE_LINES" >>"$HOME/.profile"
fi
export PATH="$HOME/.local/node/bin:$HOME/android-sdk/cmdline-tools/latest/bin:$HOME/android-sdk/platform-tools:$PATH"
export ANDROID_HOME="$HOME/android-sdk"

echo "== node"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  base=https://nodejs.org/dist/latest-v24.x
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/sums"
  tarball=$(grep -o 'node-v24[^ ]*-linux-x64\.tar\.xz' "$tmp/sums" | head -1)
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && grep " $tarball\$" sums | sha256sum -c - >/dev/null) || { echo "Node download failed its checksum"; exit 1; }
  rm -rf "$HOME/.local/node"
  mkdir -p "$HOME/.local/node"
  tar -xJf "$tmp/$tarball" -C "$HOME/.local/node" --strip-components=1
  rm -rf "$tmp"
fi
PNPM=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)
if [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM" ]; then
  npm_config_prefix="$HOME/.local/node" npm install -g --silent "pnpm@$PNPM"
fi
echo "node $(node --version), pnpm $(pnpm --version)"

echo "== android sdk"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp=$(mktemp -d)
  curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "$tmp/tools.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager --install platform-tools >/dev/null
echo "sdk in $ANDROID_HOME, licences accepted"

echo "== memory"
mem=$(awk '/MemTotal/ {print int($2 / 1048576)}' /proc/meminfo)
swap=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
if [ "$mem" -lt 6 ] && [ "$swap" -eq 0 ]; then
  $SUDO fallocate -l 4G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  echo "${mem} GB of RAM: added 4 GB of swap"
else
  echo "${mem} GB of RAM, swap: $((swap / 1024)) MB"
fi

echo "== packages for the repo"
pnpm install --frozen-lockfile --silent
echo "done"

mkdir -p "$HOME/.terminus"
chmod 700 "$HOME/.terminus"
if [ ! -f "$HOME/.terminus/env" ]; then
  cat >"$HOME/.terminus/env" <<'EOF'
# For `pnpm run deploy` and the R2 uploads in scripts/release.sh. A token
# from dash.cloudflare.com > My Profile > API Tokens: the "Edit Cloudflare
# Workers" template, plus D1 Edit. The account ID is on the Workers page.
export CLOUDFLARE_API_TOKEN=
export CLOUDFLARE_ACCOUNT_ID=
EOF
fi
chmod 600 "$HOME/.terminus/env"

echo "== still needed"
missing=0
need() { echo "  - $1"; missing=1; }
. "$HOME/.terminus/env"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || need "a Cloudflare token and account ID in ~/.terminus/env"
props="$HOME/.gradle/gradle.properties"
if grep -q '^TERMINUS_KEYSTORE=' "$props" 2>/dev/null; then
  ks=$(sed -n 's/^TERMINUS_KEYSTORE=//p' "$props")
  [ -f "$ks" ] || need "the Android keystore at $ks (named in $props): scp it from the Mac"
else
  need "the TERMINUS_* lines in $props: scp ~/.gradle/gradle.properties from the Mac"
fi
[ -f "$ROOT/apps/android/app/google-services.json" ] || need "apps/android/app/google-services.json (for push): scp it from the Mac"
git config user.email >/dev/null || need "git config --global user.name and user.email (release.sh tags as you)"
# A dry-run push of a new branch: checks write access without pushing.
GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git push --dry-run -q origin HEAD:refs/heads/vps-setup-check >/dev/null 2>&1 ||
  need "git access to push: a GitHub deploy key with write access (git@github.com:rcnsh/terminus as origin), or a fine-grained token"
if [ $missing -eq 0 ]; then
  echo "  nothing: run '. ~/.profile', then scripts/release.sh --dry-run"
else
  echo "  then run this again to check, and '. ~/.profile' (or log in again)"
fi
