#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
assembled_dir="$script_dir/.assembled"
sources=("$script_dir/target-seed")
for task in T1 T2 T3 T4; do
  sources+=("$repo_root/fixtures/agent/$task")
done

# Check inputs before removing the previous assembly.
for source_dir in "${sources[@]}"; do
  if [[ ! -d "$source_dir" ]]; then
    printf 'Missing assembly input: %s\n' "$source_dir" >&2
    exit 1
  fi
done
for tool in vitest tsc; do
  if [[ ! -x "$repo_root/node_modules/.bin/$tool" ]]; then
    printf 'Missing installed tool: node_modules/.bin/%s\n' "$tool" >&2
    exit 1
  fi
done

# This fixed path is the only output removed; never remove through a symlink.
rm -rf -- "$assembled_dir"
mkdir -- "$assembled_dir"
for source_dir in "${sources[@]}"; do
  cp -R -- "$source_dir/." "$assembled_dir/"
done

# Always use the host repository's dependencies, without downloading packages.
rm -rf -- "$assembled_dir/node_modules"
ln -s -- ../../node_modules "$assembled_dir/node_modules"
cd -- "$assembled_dir"

test_status=0
npx --no-install vitest run || test_status=$?
typecheck_status=0
if [[ -f tsconfig.json ]]; then
  ./node_modules/.bin/tsc --noEmit || typecheck_status=$?
fi

# Keep Vitest's failure code, but also fail on a standalone typecheck failure.
if (( test_status != 0 )); then
  exit "$test_status"
fi
exit "$typecheck_status"
