#!/usr/bin/env node
/**
 * release.mjs — one atomic, fail-loud release. Enforces the sequence so the ordering
 * mistakes never recur: CHANGELOG entry FIRST → version+changelog in ONE commit → tag →
 * push → publish → GitHub release. Any failed gate stops the release before anything ships.
 *
 *   node scripts/release.mjs 0.2.3        # the version whose CHANGELOG entry you already wrote
 *
 * The CHANGELOG entry is the source of truth: write `## X.Y.Z …` at the top of CHANGELOG.md
 * BEFORE running this. The script refuses to release a version with no changelog section, so a
 * published tarball always carries its own changelog. Uses your ambient npm auth (~/.npmrc) —
 * it never embeds a token.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) die(`usage: node scripts/release.mjs <X.Y.Z>  (write the CHANGELOG ## ${version || "X.Y.Z"} entry first)`);

// execSync returns NULL when stdio is "inherit" — which callers below deliberately use for
// npm test / npm run build so their output streams. Calling .trim() on that threw and killed
// the release at the tests step, i.e. this script could never complete in any repo that HAS a
// test script. Coalesce before trimming.
const run = (cmd, opts = {}) => (execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }) ?? "").trim();
const step = (msg) => process.stdout.write(`\n▸ ${msg}\n`);
function die(msg) { process.stderr.write(`\n✗ ${msg}\n`); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const hasScript = (name) => !!pkg.scripts?.[name];
const carvesOut = JSON.stringify(pkg.files || []).includes("learning-private");
const isPrivateRepo = () => { try { return run("gh repo view --json visibility -q .visibility") === "PRIVATE"; } catch { return true; } };

// ── GATES (nothing ships until every one passes) ──
step("preflight: branch, clean tree, up to date");
if (run("git rev-parse --abbrev-ref HEAD") !== "main") die("not on main");
if (run("git status --porcelain")) die("working tree not clean — commit or stash first (the CHANGELOG entry is the only change that should be here, staged by this script)");
run("git fetch -q origin");
if (run("git rev-list --count HEAD..@{u}") !== "0") die("behind origin/main — pull first");

step(`CHANGELOG has an entry for ${version}`);
const changelog = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "";
// The end-of-input alternative must be a TRUE end anchor. With the "m" flag a bare `$`
// matches the end of ANY line, so the lazy capture terminated at the first line break after
// the header and every well-formed entry — header, blank line, bullets — read as EMPTY.
// `(?![\\s\\S])` is end-of-input regardless of the multiline flag, which `^` still needs.
const section = changelog.match(new RegExp(`^## ${version.replace(/\./g, "\\.")}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, "m"));
if (!section) die(`no "## ${version}" section in CHANGELOG.md — write it first (it becomes the tag + release notes)`);
const notes = section[1].trim();
if (!notes) die(`the "## ${version}" CHANGELOG section is empty`);

if (hasScript("test")) { step("tests"); run("npm test", { stdio: "inherit" }); } else step("tests: none (skipped)");
if (hasScript("build")) { step("build"); run("npm run build", { stdio: "inherit" }); } else step("build: none (skipped)");

// Guard the moat where it applies: the grounded rules must never enter the tarball.
if (carvesOut) {
  step("carve-out: learning-private absent from the tarball");
  if (/learning-private/.test(run("npm pack --dry-run 2>&1"))) die("learning-private files are in the tarball — the IP carve-out is broken; do not publish");
}

// ── SHIP (version + changelog land in ONE commit, then tag, push, publish, release) ──
step(`bump ${pkg.version} → ${version} and commit (version + CHANGELOG together)`);
run(`npm version ${version} --no-git-tag-version`);

// Keep the plugin LAUNCH PIN and MANIFEST VERSION in lockstep with package.json. The historical
// pin-lag bug — a tag vX.Y.Z shipping a `.mcp.json` that still pinned `@sym-bot/mesh-channel@<prev>`,
// and a `plugin.json` version one behind — came from these two files being bumped by hand and
// forgotten. The release now owns them, so a tag can never again point users at an older runtime.
// Text-level replace (not parse+stringify) to preserve exact formatting.
if (fs.existsSync(".mcp.json")) {
  const before = fs.readFileSync(".mcp.json", "utf8");
  const after = before.replace(/(@sym-bot\/mesh-channel)@\d+\.\d+\.\d+/g, `$1@${version}`);
  if (!after.includes(`@sym-bot/mesh-channel@${version}`)) die(".mcp.json has no @sym-bot/mesh-channel pin to bump — check the launch config");
  fs.writeFileSync(".mcp.json", after);
}
{
  const pjPath = ".claude-plugin/plugin.json";
  if (fs.existsSync(pjPath)) {
    const after = fs.readFileSync(pjPath, "utf8").replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
    fs.writeFileSync(pjPath, after);
  }
}

run("git add package.json package-lock.json CHANGELOG.md .mcp.json .claude-plugin/plugin.json");
run(`git commit -m ${JSON.stringify(`${version}\n\n${notes}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`)}`);

step(`tag v${version} + push`);
run(`git tag -a v${version} -m ${JSON.stringify(`v${version}\n\n${notes}`)}`);
run("git push origin main");
run(`git push origin v${version}`);

step("npm publish (ambient npm auth — no embedded token)");
run("npm publish --access public", { stdio: "inherit" });

if (isPrivateRepo()) {
  step("GitHub release: SKIPPED (private repo)");
} else {
  step(`GitHub release v${version}`);
  fs.writeFileSync(".release-notes.tmp", notes);
  try { run(`gh release create v${version} --title ${JSON.stringify(`v${version}`)} --notes-file .release-notes.tmp`, { stdio: "inherit" }); }
  finally { fs.rmSync(".release-notes.tmp", { force: true }); }
}

process.stdout.write(`\n✓ released ${pkg.name}@${version} — version, CHANGELOG, tag, npm, and release all aligned.\n`);
