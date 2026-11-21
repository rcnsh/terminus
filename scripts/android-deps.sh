#!/bin/sh
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

ci=':app:ktfmtCheck :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin :app:assembleStableRelease :app:assembleBetaRelease'

cold() {
  home=$(mktemp -d "$tmp/gradle-home.XXXXXX")
  (cd "$android" && GRADLE_USER_HOME=$home ./gradlew --console=plain --no-daemon \
    --no-configuration-cache --rerun-tasks "$@")
}

echo "== Writing the lockfiles and dependency hashes"
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
