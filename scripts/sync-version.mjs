#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeTextFile(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

function updateCargoTomlVersion(filePath, nextVersion) {
  const content = fs.readFileSync(filePath, "utf8");
  const packageSectionPattern = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
  if (!packageSectionPattern.test(content)) {
    fail("Cannot locate [package].version in src-tauri/Cargo.toml");
  }
  const updated = content.replace(packageSectionPattern, `$1${nextVersion}$3`);
  writeTextFile(filePath, updated);
}

function updateCargoLockVersion(filePath, nextVersion) {
  const content = fs.readFileSync(filePath, "utf8");
  const packagePattern = /(\[\[package\]\]\nname = "open-storyboard-canvas"\nversion = ")([^"]+)(")/;
  if (!packagePattern.test(content)) {
    fail("Cannot locate open-storyboard-canvas package version in src-tauri/Cargo.lock");
  }
  const updated = content.replace(packagePattern, `$1${nextVersion}$3`);
  writeTextFile(filePath, updated);
}

function updateTauriConfigVersion(filePath, nextVersion) {
  const content = fs.readFileSync(filePath, "utf8");
  const config = JSON.parse(content);
  config.version = nextVersion;
  writeTextFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const args = process.argv.slice(2);
const nextVersion = args[0];

if (!nextVersion) {
  fail("Usage: npm run sync:version -- <version>");
}

if (!VERSION_PATTERN.test(nextVersion)) {
  fail(`Invalid semver version: ${nextVersion}`);
}

const repoRoot = resolveRepoRoot();
process.chdir(repoRoot);

execSync(`npm version ${nextVersion} --no-git-tag-version --allow-same-version`, {
  stdio: "inherit",
});

updateCargoTomlVersion(path.join(repoRoot, "src-tauri", "Cargo.toml"), nextVersion);
updateCargoLockVersion(path.join(repoRoot, "src-tauri", "Cargo.lock"), nextVersion);
updateTauriConfigVersion(path.join(repoRoot, "src-tauri", "tauri.conf.json"), nextVersion);

console.log(`Synchronized version to ${nextVersion}`);
