/**
 * End-to-end test for the custom-path backup feature (v1.3.0).
 *
 * What it verifies:
 *   1. A real directory tree (nested dirs, binary files, an empty dir, a
 *      symlink, a >50MB file that crosses the Telegram split boundary) is
 *      packed into a valid .tar.gz whose extracted contents are byte-identical.
 *   2. Symlinks are stored AS symlinks (typeflag 2), not as text files.
 *   3. A backup-manifest.json member describing the archive is present.
 *   4. validateCustomPath rejects: empty, relative, "..", the app's own root,
 *      a path that is a file rather than a directory, a missing directory.
 *   5. parseCustomPaths accepts a plain string array, an object array and
 *      malformed JSON without throwing.
 *
 * Run:  node scripts/test-custom-paths.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-build");

// ---------------------------------------------------------------------------
// 0. compile the library (the same tsc the project uses)
// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      outDir: ".",
      rootDir: path.join(ROOT, "src"),
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      skipLibCheck: true,
      strict: true,
      esModuleInterop: true,
      baseUrl: path.join(ROOT, "src"),
      paths: { "@/*": ["./*"] },
    },
    include: [path.join(ROOT, "src/lib/custom-path-client.ts"), path.join(ROOT, "src/lib/messages.ts")],
  }, null, 2)
);
const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], { encoding: "utf8" });
if (tsc.status !== 0) {
  console.error("✗ tsc failed:\n" + tsc.stdout + tsc.stderr);
  process.exit(1);
}

// tsc does not rewrite the "@/" path alias at emit — point the emitted
// require at the sibling file we compiled alongside it
const emitted = path.join(OUT, "lib/custom-path-client.js");
let code = fs.readFileSync(emitted, "utf8");
code = code.replace(/require\("@\/lib\/messages"\)/g, 'require("./messages.js")');
fs.writeFileSync(emitted, code);

const { customPathBackup, validateCustomPath, parseCustomPaths } = await import(
  pathToFileURL(path.join(OUT, "lib/custom-path-client.js")).href
);

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    console.log("  ✗ " + msg);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// 1. build a source tree worth backing up
// ---------------------------------------------------------------------------
const src = fs.mkdtempSync(path.join(os.tmpdir(), "bkup-src-"));
const subA = path.join(src, "app");
const subB = path.join(subA, "deep", "deeper");
fs.mkdirSync(subB, { recursive: true });
fs.mkdirSync(path.join(src, "empty-dir"), { recursive: true });

fs.writeFileSync(path.join(src, "config.json"), JSON.stringify({ ok: true, n: 42 }, null, 2));
fs.writeFileSync(path.join(subA, "index.js"), "console.log('hello');\n".repeat(10));
// a binary payload big enough to cross the 50MB Telegram split boundary
const big = Buffer.alloc(60 * 1024 * 1024);
for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
fs.writeFileSync(path.join(subB, "payload.bin"), big);
fs.writeFileSync(path.join(subA, "empty.txt"), "");

// Symlinks need a privilege on Windows; create them when the OS allows it
// and record which members the assertions should expect.
const symlinks = [];
function trySymlink(target, linkName) {
  try {
    fs.symlinkSync(target, path.join(src, linkName));
    symlinks.push(linkName);
    return true;
  } catch {
    console.log(`  (skipping symlink ${linkName} — not permitted on this OS)`);
    return false;
  }
}
const hasGoodLink = trySymlink("config.json", "link-to-config");
const hasBrokenLink = trySymlink("/nonexistent/target", "broken-link");

const dest = fs.mkdtempSync(path.join(os.tmpdir(), "bkup-dest-"));
const fakeCfg = { customPaths: "[]" };

console.log("\n== customPathBackup: full directory tree ==");
const res = await customPathBackup(fakeCfg, { path: src, label: "test-app" }, dest, ROOT);
check(res.ok === true, "backup reports ok");
if (!res.ok || !res.data) {
  console.error("  fatal: " + JSON.stringify(res));
  process.exit(1);
}
const { filePath, fileName, size, files } = res.data;
console.log(`  archive: ${fileName}  ${(size / 1048576).toFixed(1)} MB  ${files} files`);

check(fileName.startsWith("custom_test-app_") && fileName.endsWith(".tar.gz"), "file name follows custom_<label>_<stamp>.tar.gz");
check(fs.existsSync(filePath), "archive exists on disk");
check(size > 0, "archive is non-empty");

// 4 real files (config.json, index.js, payload.bin, empty.txt) + manifest is
// written separately; every symlink that could be created adds one member
const expectedFiles = 4 + symlinks.length;
check(files === expectedFiles, `captured ${expectedFiles} members (4 files + ${symlinks.length} symlinks) — got ${files}`);

// gzip must be valid and terminate cleanly
// (Git Bash's GNU tar reads "C:\..." as host:path — give it a POSIX path)
const posixPath = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => "/" + d.toLowerCase());
const gzCheck = spawnSync("gzip", ["-t", posixPath(filePath)], { encoding: "utf8" });
check(gzCheck.status === 0, "archive is a valid gzip stream (gzip -t)");

// ---------------------------------------------------------------------------
// 2. extract with a REAL tar and compare byte-for-byte
// ---------------------------------------------------------------------------
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "bkup-extract-"));
const tarCheck = spawnSync("tar", ["-xzf", posixPath(filePath), "-C", posixPath(extractDir)], { encoding: "utf8" });
check(tarCheck.status === 0, "GNU tar extracts the archive without warnings");

const sameBytes = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
check(fs.existsSync(path.join(extractDir, "config.json")), "config.json restored");
check(sameBytes(path.join(src, "config.json"), path.join(extractDir, "config.json")), "config.json is byte-identical");
check(sameBytes(path.join(subB, "payload.bin"), path.join(extractDir, "app/deep/deeper/payload.bin")), "large payload is byte-identical");
check(fs.statSync(path.join(extractDir, "app/empty.txt")).size === 0, "empty file preserved");
check(fs.statSync(path.join(extractDir, "empty-dir")).isDirectory(), "empty directory preserved");
if (hasGoodLink) {
  check(fs.lstatSync(path.join(extractDir, "link-to-config")).isSymbolicLink(), "symlink restored AS a symlink");
  check(fs.readlinkSync(path.join(extractDir, "link-to-config")) === "config.json", "symlink target is correct");
}
if (hasBrokenLink) {
  check(fs.lstatSync(path.join(extractDir, "broken-link")).isSymbolicLink(), "broken symlink preserved without being followed");
}

const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, "backup-manifest.json"), "utf8"));
check(manifest.source === src, "manifest records the source path");
check(manifest.label === "test-app", "manifest records the label");
check(manifest.files === files, "manifest file count matches the reported count");
check(manifest.bytes >= 60 * 1024 * 1024, "manifest byte count covers the 60MB payload");

// the archive must NOT contain the app's own directory
const listing = spawnSync("tar", ["-tzf", posixPath(filePath)], { encoding: "utf8" });
check(!listing.stdout.split("\n").some((n) => n.includes("package.json") && !n.endsWith("backup-manifest.json")), "archive does not leak the app's own files");

// ---------------------------------------------------------------------------
// 3. validateCustomPath guard rails
// ---------------------------------------------------------------------------
console.log("\n== validateCustomPath: guard rails ==");
check(validateCustomPath("", ROOT) !== null, "empty path rejected");
check(validateCustomPath("opt/folder", ROOT) !== null, "relative path rejected");
check(validateCustomPath("/opt/../etc", ROOT) !== null, "'..' in path rejected");
check(validateCustomPath(ROOT, ROOT) !== null, "the app's own root rejected");
check(validateCustomPath(path.join(ROOT, "src"), ROOT) !== null, "a directory INSIDE the app root rejected");
check(validateCustomPath(path.join(ROOT, "package.json"), ROOT) !== null, "a file (not a directory) rejected");
check(validateCustomPath(path.join(os.tmpdir(), "bkup-does-not-exist-xyz"), ROOT) !== null, "missing directory rejected");
check(validateCustomPath(src, ROOT) === null, "a real external directory accepted");

// ---------------------------------------------------------------------------
// 4. parseCustomPaths resilience
// ---------------------------------------------------------------------------
console.log("\n== parseCustomPaths: input shapes ==");
const plain = parseCustomPaths(JSON.stringify(["/opt/a", "/opt/b"]));
check(plain.length === 2 && plain[0].path === "/opt/a" && plain[0].label === "", "string array → entries with empty labels");
const objs = parseCustomPaths(JSON.stringify([{ path: "/opt/a", label: "App A" }, { path: "  /opt/b  ", label: "  Spaced  " }]));
check(objs.length === 2 && objs[1].path === "/opt/b" && objs[1].label === "Spaced", "object array parsed and trimmed");
check(parseCustomPaths("not json").length === 0, "malformed JSON → empty list, no throw");
check(parseCustomPaths(JSON.stringify({ a: 1 })).length === 0, "non-array JSON → empty list");
check(parseCustomPaths(JSON.stringify([{ nope: 1 }, { path: "/ok" }])).length === 1, "entries without a path are dropped");

// ---------------------------------------------------------------------------
// 5. cleanup
// ---------------------------------------------------------------------------
fs.rmSync(src, { recursive: true, force: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.rmSync(extractDir, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
