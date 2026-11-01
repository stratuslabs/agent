#!/usr/bin/env bash
# Publish every package under packages/ with npm provenance.
#
# `pnpm -r publish --provenance` drops the flag (security audit F5), so pnpm
# only packs: `pnpm pack` rewrites `workspace:*` to real versions, and npm
# publishes each tarball, which is the path that generates the provenance
# attestation. A version already on the registry is skipped, so a rerun
# after a partial failure finishes the release instead of failing on it.
#
# A prerelease version (1.0.0-rc.1) goes out under the `next` dist-tag and
# leaves `latest` on the last stable release, so `npm install` and
# `stratus update` never pick up a release candidate unasked. Anything else
# goes out under `latest`. npm 11 refuses a prerelease without a tag, so
# before this an rc tag failed the release on its first package.
#
# DRY_RUN=1 packs and runs `npm publish --dry-run` without provenance, which
# only a CI runner with an OIDC token can generate.
set -euo pipefail

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# Recursive exec runs in workspace dependency order (dependencies first), and
# one at a time here, so the order file lists each tarball after everything
# it depends on. Publishing in that order means an interrupted release never
# leaves a package on the registry whose exact dependency isn't there yet.
# `pnpm pack` prints the tarball's path as its last line.
pnpm --filter './packages/*' -r --workspace-concurrency=1 exec \
  sh -c 'pnpm pack --pack-destination "$1" | tail -n 1 >> "$1/order"' sh "$out" >/dev/null

published=0
skipped=0
while IFS= read -r tarball; do
  manifest="$(tar -xOzf "$tarball" package/package.json)"
  name="$(node -e 'const p = JSON.parse(process.argv[1]); process.stdout.write(p.name)' "$manifest")"
  version="$(node -e 'const p = JSON.parse(process.argv[1]); process.stdout.write(p.version)' "$manifest")"
  private="$(node -e 'const p = JSON.parse(process.argv[1]); process.stdout.write(String(p.private === true))' "$manifest")"
  if [ "$private" = "true" ]; then
    echo "skip $name: private"
    skipped=$((skipped + 1))
    continue
  fi
  if tar -xOzf "$tarball" package/package.json | grep -q '"workspace:'; then
    echo "refusing $name@$version: the packed manifest still has a workspace: dependency" >&2
    exit 1
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip $name@$version: already on the registry"
    skipped=$((skipped + 1))
    continue
  fi
  # SemVer: a prerelease is a hyphen after the patch number, and build
  # metadata after `+` may hold hyphens of its own, so it's cut off first.
  case "${version%%+*}" in
    *-*) dist_tag=next ;;
    *) dist_tag=latest ;;
  esac
  if [ "${DRY_RUN:-}" = "1" ]; then
    npm publish "$tarball" --access public --tag "$dist_tag" --dry-run >/dev/null
    echo "dry-run $name@$version under $dist_tag"
  else
    npm publish "$tarball" --access public --tag "$dist_tag" --provenance
    echo "published $name@$version under $dist_tag"
  fi
  published=$((published + 1))
done < "$out/order"
echo "done: $published published, $skipped skipped"
