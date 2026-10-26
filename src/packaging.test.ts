import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// @ts-expect-error -- plain ESM script without type declarations
import { bumpFor, nextVersion } from "../scripts/release.mjs";

test("AUR metadata links GitHub's normalized Tauri asset name and hashes its actual bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "desk-aur-test-"));
  try {
    const debDir = join(root, "src-tauri/target/release/bundle/deb");
    mkdirSync(debDir, { recursive: true });
    mkdirSync(join(root, "packaging/arch"), { recursive: true });
    copyFileSync(new URL("../packaging/arch/PKGBUILD.in", import.meta.url), join(root, "packaging/arch/PKGBUILD.in"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.6.1" }));
    writeFileSync(join(root, "LICENSE"), "license fixture");
    const payload = "package bytes fixture";
    writeFileSync(join(debDir, "Project Desk_0.6.1_amd64.deb"), payload);
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-aur.mjs", import.meta.url))], { cwd: root });
    execFileSync("tar", ["-xzf", join(root, "src-tauri/target/release/bundle/aur/project-desk-bin-0.6.1-aur.tar.gz"), "-C", root]);
    for (const file of ["PKGBUILD", ".SRCINFO"]) {
      const text = readFileSync(join(root, "project-desk-bin", file), "utf8");
      assert.ok(text.includes("https://github.com/dugynoo/project-desk/releases/download/v0.6.1/Project.Desk_0.6.1_amd64.deb"));
      assert.ok(text.includes(createHash("sha256").update(payload).digest("hex")));
      assert.ok(!text.includes("@DEB_SHA256@"));
      assert.ok(!text.includes("Project%20Desk"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release bump follows commit types; major is never inferred", () => {
  assert.equal(bumpFor(["fix: a", "feat(sidebar): b", "docs: c"]), "minor");
  assert.equal(bumpFor(["fix(linux): a", "test: b"]), "patch");
  assert.equal(bumpFor(["perf: a"]), "patch");
  assert.equal(bumpFor(["feat!: drop old state", "BREAKING CHANGE"]), "minor");
  assert.equal(bumpFor(["docs: a", "chore: b", "test(desktop): c"]), undefined);
  assert.equal(nextVersion("0.8.8", "minor"), "0.9.0");
  assert.equal(nextVersion("0.8.8", "patch"), "0.8.9");
  assert.equal(nextVersion("0.8.8", "major"), "1.0.0");
});
