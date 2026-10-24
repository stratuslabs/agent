#!/usr/bin/env bash
# Publish every package under packages/ with npm provenance.
#
# `pnpm -r publish --provenance` drops the flag (security audit F5), so pnpm
# only packs: `pnpm pack` rewrites `workspace:*` to real versions, and npm
# publishes each tarball, which is the path that generates the provenance
# attestation. A version already on the registry is skipped, so a rerun
# after a partial failure finishes the release instead of failing on it.
#
# DRY_RUN=1 packs and runs `npm publish --dry-run` without provenance, which
# only a CI runner with an OIDC token can generate.
set -euo pipefail

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

pnpm --filter './packages/*' -r exec pnpm pack --pack-destination "$out" >/dev/null

published=0
skipped=0
for tarball in "$out"/*.tgz; do
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
  if [ "${DRY_RUN:-}" = "1" ]; then
    npm publish "$tarball" --access public --dry-run >/dev/null
    echo "dry-run $name@$version"
  else
    npm publish "$tarball" --access public --provenance
    echo "published $name@$version"
  fi
  published=$((published + 1))
done
echo "done: $published published, $skipped skipped"
