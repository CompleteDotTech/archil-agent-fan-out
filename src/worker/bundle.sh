#!/usr/bin/env bash
# Optional offline handoff: bash bundle.sh <repo-dir> <base-commit> <branch> <output-path>
# Branch accepts a local short name or refs/heads/<name>. The recipient must have
# base-commit before importing an incremental bundle, for example:
#   git -C recipient fetch /path/attempt.bundle refs/heads/swarm/task:refs/heads/swarm/task
# When branch equals base, include reachable history instead (Git rejects empty
# bundles). No refs or working-tree files are changed in the source repository.
# Publish through a temporary sibling and atomic rename; output paths are relative
# to the caller's working directory. Requires bash, git, mkdir, mktemp, mv and rm.
set +x
set -euo pipefail

fail() { printf 'bundle: %s\n' "$1" >&2; exit 1; }
[[ $# -eq 4 ]] || fail 'usage: bundle.sh <repo-dir> <base-commit> <branch> <output-path>'
repo=$1
base=$2
branch=$3
output=$4
[[ -n "$output" && ! -d "$output" ]] || fail 'output must be a file path'

case "$branch" in
  refs/heads/*) ref=$branch ;;
  refs/*) fail 'branch must be a local branch' ;;
  *) ref="refs/heads/$branch" ;;
esac
git check-ref-format "$ref" >/dev/null 2>&1 || fail 'invalid branch name'
base_oid=$(git -C "$repo" rev-parse --verify --end-of-options "${base}^{commit}" 2>/dev/null) || fail 'base does not resolve to a commit'
head_oid=$(git -C "$repo" rev-parse --verify --end-of-options "${ref}^{commit}" 2>/dev/null) || fail 'branch does not resolve to a commit'
git -C "$repo" merge-base --is-ancestor "$base_oid" "$head_oid" >/dev/null 2>&1 || fail 'base must be an ancestor of branch'

parent=$(dirname -- "$output")
mkdir -p -- "$parent" 2>/dev/null || fail 'cannot create output parent'
parent=$(cd -- "$parent" && pwd -P) || fail 'cannot resolve output parent'
temporary=$(mktemp "$parent/.bundle.XXXXXXXXXX") || fail 'cannot create temporary bundle'
trap 'rm -f -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$base_oid" == "$head_oid" ]]; then
  git -C "$repo" bundle create "$temporary" "$ref" >/dev/null 2>&1 || fail 'cannot create bundle'
else
  git -C "$repo" bundle create "$temporary" "$ref" "^$base_oid" >/dev/null 2>&1 || fail 'cannot create bundle'
fi
git -C "$repo" bundle verify "$temporary" >/dev/null 2>&1 || fail 'bundle verification failed'
mv -f -- "$temporary" "$output" 2>/dev/null || fail 'cannot publish bundle'
