import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2])
  throw new Error('Pass an output directory for the mobile fork packages');
const output = path.resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const packages = new Map(
  readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const directory = path.join(root, 'packages', entry.name);
        const manifest = JSON.parse(
          readFileSync(path.join(directory, 'package.json'), 'utf8')
        );
        return [[manifest.name, { directory, manifest }]];
      } catch {
        return [];
      }
    })
);
const selected = new Set();
function include(name) {
  if (selected.has(name)) return;
  selected.add(name);
  for (const dependency of Object.keys(
    packages.get(name).manifest.dependencies ?? {}
  )) {
    if (packages.has(dependency)) include(dependency);
  }
}
for (const name of ['gt', 'gt-react', 'gt-react-native']) include(name);
execFileSync(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=gt...',
    '--filter=gt-react...',
    '--filter=gt-react-native...',
    '--ui=stream',
  ],
  { cwd: root, stdio: 'inherit' }
);
const manifest = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  packages: {},
};
for (const name of [...selected].sort()) {
  const temporary = mkdtempSync(
    path.join(tmpdir(), 'special-translation-pack-')
  );
  try {
    const pkg = packages.get(name);
    execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: pkg.directory,
      stdio: 'pipe',
    });
    const archive = readdirSync(temporary).find((file) =>
      file.endsWith('.tgz')
    );
    const source = path.join(temporary, archive);
    const sha256 = createHash('sha256')
      .update(readFileSync(source))
      .digest('hex');
    const filename = `${name.replace('@', '').replaceAll('/', '-')}-${sha256.slice(0, 12)}.tgz`;
    cpSync(source, path.join(output, filename));
    manifest.packages[name] = {
      filename,
      version: pkg.manifest.version,
      sha256,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
cpSync(path.join(root, 'LICENSE.md'), path.join(output, 'LICENSE.md'));
writeFileSync(
  path.join(output, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(`Packaged ${selected.size} fork packages in ${output}`);
