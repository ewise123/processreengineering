#!/usr/bin/env bash
#
# Cleanroom rule.
#
# In Cleanroom, one model writes the tests from the spec and a different model
# writes the implementation. That separation is the point: an implementer that
# can edit the tests will, sooner or later, delete a failing one rather than
# fix the code.
#
# Agent commits carry a trailer saying which role produced them:
#
#     Cleanroom-Role: test-writer
#     Cleanroom-Role: implementer
#
# This check fails the build if a commit marked `implementer` modifies a test
# file. Commits with no trailer are ignored, so ordinary human work is
# unaffected.
#
# Note: pipefail without -u. An unset variable in a sourced shell snapshot has
# bitten us before, and -e plus pipefail is enough here.

set -eo pipefail

BASE="${1:?usage: cleanroom-rule.sh <base-sha> <head-sha>}"
HEAD="${2:?usage: cleanroom-rule.sh <base-sha> <head-sha>}"

is_test_path() {
  case "$1" in
    backend/tests/*|*/conftest.py|conftest.py)     return 0 ;;
    test_*.py|*/test_*.py|*_test.py|*/*_test.py)   return 0 ;;
    *.test.ts|*.test.tsx|*.test.js|*.test.jsx)     return 0 ;;
    *.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx)     return 0 ;;
    *) return 1 ;;
  esac
}

violations=0
implementer_commits=0

for sha in $(git rev-list "$BASE".."$HEAD"); do
  # Scan the whole message rather than using git's trailer parser. Git only
  # treats the LAST paragraph as trailers, so a Cleanroom-Role line followed by
  # a blank line and a Co-Authored-By block is invisible to
  # %(trailers:key=...). That failure mode is silent: the check passes when it
  # should fail, which is the worst way for a gate to be wrong.
  role=$(git log -1 --format='%B' "$sha" \
         | grep -iE '^[[:space:]]*Cleanroom-Role:[[:space:]]*' \
         | head -1 | cut -d: -f2- | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' \
         || true)   # grep exits 1 on no match; pipefail would abort the script

  [ "$role" = "implementer" ] || continue
  implementer_commits=$((implementer_commits + 1))

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if is_test_path "$file"; then
      echo "::error::Commit ${sha:0:8} is marked Cleanroom-Role: implementer but modifies a test file: ${file}"
      violations=$((violations + 1))
    fi
  done < <(git diff-tree --no-commit-id --name-only -r "$sha")
done

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Cleanroom rule violated."
  echo "The model that writes the implementation must not touch the tests."
  echo "If a test is genuinely wrong, that is a separate commit by the test writer."
  exit 1
fi

if [ "$implementer_commits" -eq 0 ]; then
  echo "Cleanroom rule: no commits marked 'implementer' in this range. Nothing to check."
else
  echo "Cleanroom rule: ${implementer_commits} implementer commit(s) checked, no test files touched."
fi
