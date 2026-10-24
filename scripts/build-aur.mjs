// Generate a reviewable AUR source package against this release's versioned URLs.
// This does not publish to AUR or require AUR credentials.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version');
const debDir = 'src-tauri/target/release/bundle/deb';
const debs = readdirSync(debDir).filter(n => n.endsWith('_amd64.deb'));
if (debs.length !== 1) throw new Error('Expected exactly one amd64 Debian package');
if (!/^[A-Za-z0-9][A-Za-z0-9_. -]*_amd64\.deb$/.test(debs[0])) throw new Error('Unexpected Debian asset filename');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const debHash = hash(join(debDir, debs[0]));
const licenseHash = hash('LICENSE');
// GitHub release uploads normalize spaces in Tauri's product name to dots.
const assetName = debs[0].replaceAll(' ', '.');
const debUrl = `https://github.com/dugynoo/project-desk/releases/download/v${version}/${assetName}`;
const licenseUrl = `https://raw.githubusercontent.com/dugynoo/project-desk/v${version}/LICENSE`;
const template = readFileSync('packaging/arch/PKGBUILD.in', 'utf8');
const pkgbuild = template.replaceAll('@VERSION@', version).replaceAll('@DEB_SHA256@', debHash)
  .replaceAll('@LICENSE_SHA256@', licenseHash)
  .replace("source=('project-desk.deb' 'LICENSE')", `source=('project-desk.deb::${debUrl}' 'LICENSE::${licenseUrl}')`);
const values = key => [...template.matchAll(new RegExp(`^${key}=\\((.*)\\)$`, 'gm'))]
  .flatMap(m => [...m[1].matchAll(/'([^']*)'/g)].map(v => v[1]));
const srcinfo = [
  'pkgbase = project-desk-bin',
  'pkgdesc = Desktop workspace for Claude Code, Codex, Antigravity and shell sessions',
  `pkgver = ${version}`, 'pkgrel = 1', 'url = https://github.com/dugynoo/project-desk',
  ...['arch', 'license', 'depends', 'optdepends', 'provides', 'conflicts', 'options', 'noextract']
    .flatMap(key => values(key).map(value => `${key} = ${value}`)),
  `source = project-desk.deb::${debUrl}`, `source = LICENSE::${licenseUrl}`,
  `sha256sums = ${debHash}`, `sha256sums = ${licenseHash}`, '', 'pkgname = project-desk-bin', '',
].join('\n');
const work = mkdtempSync(join(tmpdir(), 'project-desk-aur-'));
try {
  const dir = join(work, 'project-desk-bin'); mkdirSync(dir);
  writeFileSync(join(dir, 'PKGBUILD'), pkgbuild);
  writeFileSync(join(dir, '.SRCINFO'), srcinfo);
  const out = resolve('src-tauri/target/release/bundle/aur'); mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-czf', join(out, `project-desk-bin-${version}-aur.tar.gz`), '-C', work, 'project-desk-bin']);
} finally { rmSync(work, { recursive: true }); }
