#!/usr/bin/env bash
# Create the GitHub Release for a v* tag, once the release workflow has
# published that version to npm.
#
# The notes are GitHub's generated notes: every pull request merged since the
# previous v* tag this one descends from, with a compare link. Without that
# start tag GitHub counts from the latest Release, which can be many tags back.
# A tag that already has a Release, draft or not, is left alone, so a rerun
# of the workflow doesn't fail on it or replace notes someone wrote by hand.
#
# DRY_RUN=1 prints the notes and the command instead of creating anything.
set -euo pipefail

tag="${1:?usage: scripts/github-release.sh <tag>}"
case "$tag" in
  v[0-9]*) ;;
  *)
    echo "refusing $tag: release tags look like v1.2.3" >&2
    exit 1
    ;;
esac

if existing="$(gh release view "$tag" --json isDraft --jq 'if .isDraft then "a draft" else "one" end' 2>/dev/null)"; then
  echo "skip $tag: it already has $existing GitHub Release"
  exit 0
fi

# --verify-tag refuses to run if the tag isn't on GitHub, instead of letting
# gh create a tag at the default branch.
args=(release create "$tag" --verify-tag --title "$tag" --generate-notes)
previous=""
if previous="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$tag^" 2>/dev/null)"; then
  args+=(--notes-start-tag "$previous")
fi
case "$tag" in
  *-*) args+=(--prerelease) ;;
esac

if [ "${DRY_RUN:-}" = "1" ]; then
  notes=(api 'repos/{owner}/{repo}/releases/generate-notes' -f "tag_name=$tag" --jq .body)
  if [ -n "$previous" ]; then
    notes+=(-f "previous_tag_name=$previous")
  fi
  gh "${notes[@]}"
  echo
  echo "dry-run: gh ${args[*]}"
  exit 0
fi

gh "${args[@]}"
echo "released $tag"
