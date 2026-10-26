// Vydanie jedným príkazom: npm run release [-- major|minor|patch] [-- --dry-run]
// Verziu odvodí z Conventional Commits od posledného tagu: feat → minor, fix/perf → patch.
// Major len ručne. Commitne verziu aj RELEASE_NOTES.md, vytvorí tag a pushne ich naraz;
// tag spustí Release workflow, ktorý vydanie po úspešnom builde všetkých platforiem zverejní.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BUMPS = ["patch", "minor", "major"];

/** Typ zvýšenia podľa predmetov commitov; `undefined`, ak nie je čo vydať. */
export function bumpFor(subjects) {
  const types = subjects.map(subject => /^(\w+)(?:\([^)]*\))?!?:/.exec(subject)?.[1]);
  if (types.includes("feat")) return "minor";
  if (types.includes("fix") || types.includes("perf")) return "patch";
}

export function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = message => { console.error(`release: ${message}`); process.exit(1); };

function main(args) {
  const dryRun = args.includes("--dry-run");
  const override = args.find(arg => !arg.startsWith("--"));
  if (override && !BUMPS.includes(override)) fail(`unknown bump "${override}", use major, minor or patch`);

  if (git("branch", "--show-current") !== "master") fail("run it on master");
  git("fetch", "--quiet", "origin", "master", "--tags");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/master")) fail("master differs from origin/master; pull or push first");
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean);
  if (dirty.some(line => line.slice(3) !== "RELEASE_NOTES.md")) fail(`only RELEASE_NOTES.md may be uncommitted:\n${dirty.join("\n")}`);

  const lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  const notes = readFileSync("RELEASE_NOTES.md", "utf8").trim();
  if (!notes || notes === git("show", `${lastTag}:RELEASE_NOTES.md`).trim()) fail(`write RELEASE_NOTES.md for this release (it still matches ${lastTag})`);

  const subjects = git("log", "--format=%s", `${lastTag}..HEAD`).split("\n").filter(Boolean);
  const bump = override ?? bumpFor(subjects);
  if (!bump) fail(`no feat/fix/perf commits since ${lastTag}; pass patch to release anyway`);
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  const version = nextVersion(current, bump);

  console.log(`${current} → ${version} (${bump}${override ? ", manual" : ""}), ${subjects.length} commits since ${lastTag}\n\n${notes}\n`);
  if (dryRun) return console.log("Dry run: nothing changed.");

  // Bez git tagu z npm: skript "version" zosynchronizuje Cargo súbory a pridá ich do indexu.
  execFileSync("npm", ["version", version, "--no-git-tag-version"], { stdio: "inherit", shell: process.platform === "win32" });
  git("add", "package.json", "package-lock.json", "RELEASE_NOTES.md");
  git("commit", "--quiet", "-m", `chore: release ${version}`);
  git("tag", "-a", `v${version}`, "-m", version);
  execFileSync("git", ["push", "--atomic", "origin", "master", `v${version}`], { stdio: "inherit" });
  console.log(`\nPushed v${version}. The Release workflow publishes it only after full CI and every platform build succeed.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
