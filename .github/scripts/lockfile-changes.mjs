// Lists the packages whose resolved versions differ between two pnpm
// lockfiles, one line per package name: `name: old -> new`. Used by the
// fresh-deps workflow to say which dependencies moved when it resolved every
// range fresh. Reads only the `packages:` section, where each key is one
// resolved `name@version`.
//
// usage: node lockfile-changes.mjs BEFORE.yaml AFTER.yaml
import { readFileSync } from 'node:fs';

function resolvedVersions(path) {
  const versions = new Map();
  let inPackages = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^'(:\s]+)'?:/.exec(line);
    if (!key) continue;
    const [, name, version] = key;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node lockfile-changes.mjs BEFORE.yaml AFTER.yaml');
  process.exit(2);
}
const before = resolvedVersions(beforePath);
const after = resolvedVersions(afterPath);
const list = (set) => (set && set.size > 0 ? [...set].sort().join(', ') : 'none');
const lines = [];
for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  const was = list(before.get(name));
  const now = list(after.get(name));
  if (was !== now) lines.push(`- ${name}: ${was} -> ${now}`);
}
console.log(
  lines.length === 0
    ? 'Fresh resolution matches pnpm-lock.yaml: no dependency moved.'
    : `Fresh resolution moved ${lines.length} package(s) from pnpm-lock.yaml:\n\n${lines.join('\n')}`,
);
