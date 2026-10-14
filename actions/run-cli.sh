#!/usr/bin/env bash
set -euo pipefail

if [ -n "${BASE_URL:-}" ]; then export HOMERUN_BASE_URL="$BASE_URL"; fi
if [ -n "${API_KEY:-}" ]; then export HOMERUN_API_KEY="$API_KEY"; fi

output="$("$RUNNER_TEMP/homerun-cli/homerun" "$@")"
if [ "${MASK_OUTPUT:-}" = "true" ]; then
	if [ -n "$output" ]; then echo "::add-mask::$output"; fi
else
	printf '%s\n' "$output" | tee "$RUNNER_TEMP/homerun-cli/stdout"
fi
delimiter="HOMERUN_$RANDOM$RANDOM$RANDOM"
printf 'stdout<<%s\n%s\n%s\n' "$delimiter" "$output" "$delimiter" >> "$GITHUB_OUTPUT"
