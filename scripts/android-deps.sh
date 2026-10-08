#!/bin/sh
# The Android app's lockfiles and dependency hashes, written again after a
# version changes: a Dependabot PR (Dependabot edits only the build files)
# or a hand edit to gradle/libs.versions.toml. CI fails until both are
# written.
#
#   scripts/android-deps.sh 42     # Dependabot's PR #42, in its own worktree
#   scripts/android-deps.sh        # this checkout's apps/android, as it is
#
# Gradle runs from an empty Gradle home, as on a fresh CI runner: it records
# only the files it downloads, and a warm cache leaves out some that a cold
# runner fetches, so CI would fail now and then. It
#   1. writes the lockfiles (app/gradle.lockfile, buildscript- and settings-)
#      and gradle/verification-metadata.xml, running every task CI runs
#   2. checks each new hash against the repository's own and adds the aapt2
#      jars for the other systems (scripts/android_deps.py); it stops on a
#      hash that changed for a version already listed
#   3. runs CI's tasks once more from another empty Gradle home, with
#      verification on
# and leaves the changes uncommitted for you to review, printing the
# commands that commit and push them.
#
# The empty Gradle home also keeps ~/.gradle/gradle.properties (the signing
# keys) out of the build. Gradle runs the new versions' plugin code here
# before any hash is checked, as CI does: Dependabot's cooldown
# (.github/dependabot.yml) is what holds back a bad release. Takes about
# 15 minutes.
set -eu

root=$(git rev-parse --show-toplevel)
pr=${1:-}
case $pr in
  *[!0-9]*) echo "usage: $0 [pr-number]" >&2; exit 2 ;;
esac

if [ -n "$pr" ]; then
  branch=$(gh pr view "$pr" --json headRefName,isCrossRepository \
    --jq 'if .isCrossRepository then "" else .headRefName end')
  if [ -z "$branch" ]; then
    echo "PR #$pr comes from a fork; push to it from there" >&2
    exit 1
  fi
  work=$root/build/android-deps/pr-$pr
  if [ -e "$work" ]; then
    echo "$work is already there: finish with it, then git worktree remove $work" >&2
    exit 1
  fi
  git -C "$root" fetch -q origin "$branch"
  git -C "$root" worktree add -q --detach "$work" "origin/$branch"
  # Where the Android SDK is; local.properties is kept out of git.
  if [ -f "$root/apps/android/local.properties" ]; then
    cp "$root/apps/android/local.properties" "$work/apps/android/"
  fi
else
  work=$root
fi
android=$work/apps/android
if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ] && ! grep -qs '^sdk.dir=' "$android/local.properties"; then
  echo "No Android SDK: set ANDROID_HOME, or sdk.dir in apps/android/local.properties" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$android/gradle/verification-metadata.xml" "$tmp/before.xml"

ci=':app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin :app:assembleStableRelease :app:assembleBetaRelease'

# Each run gets a Gradle home of its own and reruns every task, so nothing
# downloaded or built before stands in for a download.
cold() {
  home=$(mktemp -d "$tmp/gradle-home.XXXXXX")
  (cd "$android" && GRADLE_USER_HOME=$home ./gradlew --console=plain --no-daemon \
    --no-configuration-cache --rerun-tasks "$@")
}

echo "== Writing the lockfiles and dependency hashes"
# One run for both, so everything is downloaded once: resolving every
# configuration for the locks fetches POMs no CI task asks for, and the
# release builds (R8) fetch files nothing else does.
# shellcheck disable=SC2086 # $ci is a list of tasks
cold :app:resolveAll buildEnvironment $ci --write-locks --write-verification-metadata sha256
echo "== Checking them against the repositories"
python3 -I "$root/scripts/android_deps.py" "$tmp/before.xml" "$android/gradle/verification-metadata.xml"
echo "== Building as CI does, from an empty Gradle home"
# shellcheck disable=SC2086
cold $ci

files='apps/android/app/gradle.lockfile apps/android/buildscript-gradle.lockfile apps/android/settings-gradle.lockfile apps/android/gradle/verification-metadata.xml'
echo
# shellcheck disable=SC2086
git -C "$work" diff --stat -- $files
echo
echo "Review:  git -C $work diff -- apps/android"
echo "Commit:  git -C $work add -- $files"
echo "         git -C $work commit -m \"build(deps): lock and verify the android group's new versions\""
if [ -n "$pr" ]; then
  echo "Push:    git -C $work push origin HEAD:$branch"
  echo "Then:    git worktree remove $work"
fi
