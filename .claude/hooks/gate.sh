#!/usr/bin/env bash
set -uo pipefail

cd "$CLAUDE_PROJECT_DIR"

if [ -z "$(git status --porcelain)" ]; then
  exit 0
fi

stamp="$(git rev-parse --git-path claude-gate-passed)"
fingerprint() {
  {
    git rev-parse HEAD
    git diff HEAD --binary
    git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null
  } | shasum | cut -d' ' -f1
}
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(fingerprint)" ]; then
  exit 0
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

gate() {
  local name="$1"
  shift
  if ! "$@" >"$log" 2>&1; then
    {
      echo "$name failed, fix it before handing back: $*"
      grep -E "^\(fail\)|^--- FAIL|^FAIL" "$log"
      awk -F'|' '/^ [^ ].*\|/ && $2 ~ /[0-9]/ && ($2 + 0 < 80 || $3 + 0 < 80) { print "below the 80% coverage threshold:" $0 }' "$log"
      grep -E "error|Error|FAIL|fail|✖|below|threshold" "$log" | grep -v -E "^\s*$|^\(fail\)" | tail -40
      echo "--- last lines ---"
      tail -40 "$log"
    } >&2
    exit 2
  fi
}

gate "Type check" bun run check
gate "prek" prek run
gate "Unit tests (coverage threshold included)" bun run test

fingerprint >"$stamp"
