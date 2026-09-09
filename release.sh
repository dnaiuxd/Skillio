#!/bin/bash
#
# Cut a Skillio release: bump the version, commit it, tag it.
#
#     ./release.sh patch          1.0.0 -> 1.0.1
#     ./release.sh minor          1.0.0 -> 1.1.0
#     ./release.sh major          1.0.0 -> 2.0.0
#     ./release.sh 1.4.2          set it explicitly
#     ./release.sh minor --dry-run    show what would happen, change nothing
#
# The version lives in exactly one place — SKILLIO_VERSION in backend/app.py —
# and everything else reads it from /api/health. This script is the only thing
# that should ever edit that line, so the number in the UI, the number in the
# commit and the number on the tag cannot drift apart.
#
# It does NOT push. Pushing is your call; the last line tells you the command.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="backend/app.py"
DRY_RUN=0

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# --- arguments -------------------------------------------------------------
BUMP="${1:-}"
[ -n "$BUMP" ] || fail "say what to bump: patch | minor | major | an explicit version like 1.4.2"
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

# --- refuse to release from a state you'd regret ---------------------------
git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git repository"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH' — release from main"

# A dirty tree means the tag would not describe what you tested. The version
# bump itself is the only change this script expects to commit.
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree has uncommitted changes — commit or stash them first"
fi

# --- read the current version ----------------------------------------------
CURRENT="$(sed -n 's/^SKILLIO_VERSION = "\(.*\)"$/\1/p' "$APP")"
[ -n "$CURRENT" ] || fail "could not find SKILLIO_VERSION in $APP"

case "$CURRENT" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "current version '$CURRENT' is not MAJOR.MINOR.PATCH" ;;
esac

IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEXT="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) NEXT="$BUMP" ;;
  *) fail "'$BUMP' is not patch, minor, major, or a MAJOR.MINOR.PATCH version" ;;
esac

TAG="v$NEXT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && fail "tag $TAG already exists"

say "current:  $CURRENT"
say "next:     $NEXT  (tag $TAG)"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n  --dry-run: nothing changed.\n\n'
  exit 0
fi

# --- tests gate the release ------------------------------------------------
# A tag is a promise that this commit works. Run the suites against the tree
# as it stands, before the bump — the bump cannot break them, and a failure
# here leaves the repo untouched.
printf '\n  running tests…\n'
# Held rather than streamed — unittest reports on stderr, so a plain
# >/dev/null still dumps its summary into the middle of the release output.
# On a failure the whole thing is printed, which is the only time it helps.
TEST_LOG="$(mktemp)"
trap 'rm -f "$TEST_LOG"' EXIT
if ! ./run-tests.sh >"$TEST_LOG" 2>&1; then
  cat "$TEST_LOG" >&2
  fail "tests failed — not releasing."
fi
say "tests passed"

# --- bump, commit, tag -----------------------------------------------------
# Anchored to the whole line so this can only ever rewrite the declaration.
sed -i '' "s/^SKILLIO_VERSION = \"$CURRENT\"\$/SKILLIO_VERSION = \"$NEXT\"/" "$APP"

if [ -z "$(git status --porcelain -- "$APP")" ]; then
  fail "the version line in $APP did not change — nothing to release"
fi

git add "$APP"
git commit --quiet -m "Release $TAG"
# Annotated rather than lightweight: a release tag carries a date and an
# author, and `git describe` ignores lightweight tags by default.
git tag -a "$TAG" -m "Skillio $NEXT"

printf '\n  committed and tagged %s\n\n' "$TAG"
say "push it with:"
say "    git push --follow-tags origin main"
printf '\n'
