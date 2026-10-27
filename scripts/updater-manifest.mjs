// Zloží latest.json pre updater z hotového konceptu vydania, až keď dobehnú všetky buildy.
// Paralelné buildy si ho inak navzájom prepisovali a manifestu chýbali platformy.
// Použitie v CI: RELEASE_TAG=v1.2.3 GH_REPO=owner/repo node scripts/updater-manifest.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Rovnaké kľúče, aké zapisovala tauri-action; prvý kľúč platformy je ten, ktorý updater hľadá.
const PLATFORMS = [
  { keys: ["windows-x86_64", "windows-x86_64-nsis"], suffix: "_x64-setup.exe" },
  { keys: ["darwin-aarch64", "darwin-aarch64-app"], suffix: "_aarch64.app.tar.gz" },
  { keys: ["darwin-x86_64", "darwin-x86_64-app"], suffix: "_x64.app.tar.gz" },
  { keys: ["linux-x86_64", "linux-x86_64-appimage"], suffix: "_amd64.AppImage" },
  { keys: ["linux-x86_64-deb"], suffix: "_amd64.deb" },
  { keys: ["linux-x86_64-rpm"], suffix: ".x86_64.rpm" },
];

/**
 * @param {{ version: string, notes: string, pubDate: string, repo: string,
 *   assets: { id: number, name: string }[], signature: (name: string) => string }} release
 */
export function updaterManifest({ version, notes, pubDate, repo, assets, signature }) {
  const platforms = {};
  for (const { keys, suffix } of PLATFORMS) {
    const matches = assets.filter(a => a.name.endsWith(suffix) && a.name.includes(version));
    if (matches.length !== 1) throw new Error(`expected one *${suffix} asset for ${version}, found ${matches.length}`);
    const [asset] = matches;
    if (!assets.some(a => a.name === `${asset.name}.sig`)) throw new Error(`${asset.name} has no signature`);
    const entry = { signature: signature(`${asset.name}.sig`), url: `https://api.github.com/repos/${repo}/releases/assets/${asset.id}` };
    for (const key of keys) platforms[key] = entry;
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function main() {
  const tag = process.env.RELEASE_TAG, repo = process.env.GH_REPO;
  if (!tag?.startsWith("v") || !repo) throw new Error("RELEASE_TAG and GH_REPO are required");
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Koncepty vydaní nevracia endpoint releases/tags/<tag>, iba zoznam.
  const release = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`))
    .flat().find(r => r.tag_name === tag);
  if (!release) throw new Error(`release ${tag} not found`);
  const dir = mkdtempSync(join(tmpdir(), "updater-manifest-"));
  try {
    gh("release", "download", tag, "--repo", repo, "--pattern", "*.sig", "--dir", dir);
    const manifest = updaterManifest({ version: tag.slice(1), notes: (release.body ?? "").trim(),
      pubDate: new Date().toISOString(), repo, assets: release.assets,
      signature: name => readFileSync(join(dir, name), "utf8") });
    const file = join(dir, "latest.json");
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    gh("release", "upload", tag, "--repo", repo, file, "--clobber");
    console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
