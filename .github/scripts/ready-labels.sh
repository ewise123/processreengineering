#!/usr/bin/env bash
#
# Maintain the `status:ready` label.
#
# `status:ready` means "cleared for an agent to pick up". It is opt-in. This
# script only ever PROMOTES an issue that was explicitly waiting, and DEMOTES one
# whose blockers reopened. It never labels a plain backlog issue.
#
# Declare blockers in the issue body, one line, anywhere:
#
#     Blocked by: #12, #15
#
# An issue enters the pipeline by being given `status:blocked` (by the planner, or
# by this script when it declares open blockers). When its blockers all close, it
# becomes ready.
#
# Why not "no blockers means ready": a first dry run against 31 real open issues
# would have marked 24 of them ready at once. Most issues are backlog, not queued
# work, and readiness that arrives by default would have launched two dozen agents
# and spent a month's budget in an afternoon.
#
# This never removes `status:in-progress`, `status:done` or `status:parked`, and
# it never labels an issue already carrying one of those: those are human states
# and the automation does not overrule them.
#
# Default is a dry run. Pass --apply to actually change labels.
#
# Reports what it examined, not just what it changed. A run that looked at zero
# issues is a bug, not a quiet success.

set -eo pipefail

REPO="${REPO:-ewise123/processreengineering}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

READY="status:ready"
BLOCKED="status:blocked"
HANDS_OFF="status:in-progress status:done status:parked"

examined=0; made_ready=0; made_blocked=0; untouched=0; opaque=0

# Cache closed-state lookups; an epic can name the same blocker many times.
declare -A STATE
issue_state(){
  local n="$1"
  if [ -z "${STATE[$n]:-}" ]; then
    STATE[$n]=$(gh issue view "$n" --repo "$REPO" --json state --jq .state 2>/dev/null || echo UNKNOWN)
  fi
  printf '%s' "${STATE[$n]}"
}

has_label(){ echo "$1" | tr ',' '\n' | grep -qxF "$2"; }

while IFS=$'\t' read -r num labels body; do
  [ -n "$num" ] || continue
  examined=$((examined + 1))

  skip=0
  for l in $HANDS_OFF; do has_label "$labels" "$l" && skip=1; done
  if [ "$skip" -eq 1 ]; then untouched=$((untouched + 1)); continue; fi

  # "Blocked by: #12, #15" or "Blocked by #12" — anywhere in the body.
  blockers=$(printf '%s' "$body" \
    | grep -ioE 'blocked by:?[^\n]*' \
    | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)

  open_blockers=""
  for b in $blockers; do
    [ "$b" = "$num" ] && continue
    [ "$(issue_state "$b")" = "OPEN" ] && open_blockers="$open_blockers #$b"
  done

  if [ -n "$open_blockers" ]; then
    # Demote: it is waiting on something, whatever it currently says.
    has_label "$labels" "$BLOCKED" && ! has_label "$labels" "$READY" \
      && { untouched=$((untouched + 1)); continue; }
    echo "  #$num  -> $BLOCKED  (waiting on$open_blockers)"
    made_blocked=$((made_blocked + 1))
    [ "$APPLY" -eq 1 ] && gh issue edit "$num" --repo "$REPO" \
        --add-label "$BLOCKED" --remove-label "$READY" >/dev/null 2>&1 || true
  elif has_label "$labels" "$BLOCKED" && [ -n "$blockers" ]; then
    # Promote: it declared blockers, and they are all closed now.
    echo "  #$num  -> $READY  (declared blockers all closed)"
    made_ready=$((made_ready + 1))
    [ "$APPLY" -eq 1 ] && gh issue edit "$num" --repo "$REPO" \
        --add-label "$READY" --remove-label "$BLOCKED" >/dev/null 2>&1 || true
  elif has_label "$labels" "$BLOCKED"; then
    # Blocked by a human, for a reason not written down anywhere this can read.
    # Absence of a declared blocker is not evidence that nothing blocks it, so
    # leave it alone rather than clearing someone else's judgement.
    opaque=$((opaque + 1))
  else
    # Plain backlog. Not this script's business. Readiness is opt-in.
    untouched=$((untouched + 1))
  fi
done < <(gh issue list --repo "$REPO" --state open --limit 200 \
          --json number,labels,body \
          --jq '.[] | [.number, ([.labels[].name] | join(",")), (.body // "" | gsub("\n"; " "))] | @tsv')

echo
if [ "$examined" -eq 0 ]; then
  echo "::error::Examined 0 open issues. A repo with no open issues is possible," \
       "but this is far more likely a bad query or a missing token. Failing rather" \
       "than reporting a clean run over nothing."
  exit 1
fi
MODE=$([ "$APPLY" -eq 1 ] && echo applied || echo "dry run, nothing changed")
echo "Ready labels: examined $examined open issue(s); $made_ready to ready;" \
     "$made_blocked to blocked; $opaque blocked with no declared blocker (left alone);" \
     "$untouched already correct or hands-off. [$MODE]"
