#!/usr/bin/env bash
set -euo pipefail

version="${CLI_VERSION:-}"
if [ -z "$version" ]; then
	if [[ "${ACTION_REF:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
		version="$ACTION_REF"
	else
		version="latest"
	fi
fi

install_dir="$RUNNER_TEMP/homerun-cli"
if [ ! -x "$install_dir/homerun" ]; then
	HOMERUN_INSTALL_DIR="$install_dir" bash "$(dirname "$0")/../cmd/cli/install.sh" "--version=$version"
fi
echo "$install_dir" >> "$GITHUB_PATH"
echo "path=$install_dir/homerun" >> "$GITHUB_OUTPUT"
