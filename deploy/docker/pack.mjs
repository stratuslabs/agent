// Packs every publishable package under packages/ into one directory, and
// writes the package.json that installs them there. Run by the Dockerfile's
// builder stage; see docs/guides/deployment.md.
//
//   node deploy/docker/pack.mjs <repo root> <output directory>
//
// Tarballs rather than the workspace itself, because a tarball is what npm
// publishes: `pnpm pack` rewrites every `workspace:*` range to the version
// beside it and ships only each manifest's `files`, so the image runs the
// same bytes an `npm install -g` of this commit would — not a source tree
// that happens to work because pnpm links everything to everything.
//
// Every package is a direct dependency, so npm installs them flat in one
// node_modules. That is what the CLI needs: it finds its companions and
// plugins with `import.meta.resolve` from its own module, the way a global
// install finds its siblings. And every one is also an override pointing at
// its tarball, so a transitive `@stratusagent/core@0.11.6` is this commit's
// core rather than whatever the registry holds under that version — a local
// build must never quietly mix in published code.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [root, out] = process.argv.slice(2);
if (!root || !out) {
  throw new Error('Usage: node deploy/docker/pack.mjs <repo root> <output directory>');
}
mkdirSync(out, { recursive: true });

const readManifest = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
};

const tarballs = {};
for (const entry of readdirSync(path.join(root, 'packages')).sort()) {
  const dir = path.join(root, 'packages', entry);
  const manifest = readManifest(dir);
  // `fixtures/` is never walked, and a private package under packages/
  // would not be published either — the image holds what npm would.
  if (!manifest || manifest.private === true) {
    continue;
  }
  const before = new Set(readdirSync(out));
  execFileSync('pnpm', ['pack', '--pack-destination', path.resolve(out)], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  const made = readdirSync(out).filter((name) => name.endsWith('.tgz') && !before.has(name));
  if (made.length !== 1) {
    throw new Error(`Packing ${manifest.name} produced ${made.length} tarballs in ${out}; expected exactly one.`);
  }
  tarballs[manifest.name] = `file:packs/${made[0]}`;
}

if (!tarballs['@stratusagent/cli']) {
  throw new Error(`No @stratusagent/cli under ${path.join(root, 'packages')} — is that the repository root?`);
}

writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({
  name: 'stratus-image',
  private: true,
  description: 'Every first-party Stratus package, installed flat from this commit\'s tarballs.',
  dependencies: tarballs,
  overrides: tarballs,
}, null, 2)}\n`);
process.stdout.write(`packed ${Object.keys(tarballs).length} packages into ${out}\n`);
