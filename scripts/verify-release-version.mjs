#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const semver = /^\d+\.\d+\.\d+$/;
const jsonArtifacts = [
  "package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/ingest/package.json",
  "packages/pricing/package.json",
  "packages/storage-clickhouse/package.json",
  "packages/storage-postgres/package.json",
  "packages/updater/package.json",
];

const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const rootVersion = JSON.parse(read("package.json")).version;
const expected = process.argv[2] ?? rootVersion;
const failures = [];

if (!semver.test(expected) || expected === "0.0.0") {
  failures.push(`expected version must be an unprefixed, non-development semver: ${expected}`);
}

for (const relativePath of jsonArtifacts) {
  const actual = JSON.parse(read(relativePath)).version;
  if (actual !== expected) failures.push(`${relativePath}: expected ${expected}, got ${actual}`);
}

function checkCaptures(relativePath, expression, expectedCount) {
  const actual = [...read(relativePath).matchAll(expression)].map((match) => match[1]);
  if (actual.length !== expectedCount || actual.some((version) => version !== expected)) {
    failures.push(`${relativePath}: expected ${expectedCount} occurrence(s) of ${expected}, got [${actual.join(", ")}]`);
  }
}

checkCaptures("shim/rust/Cargo.toml", /^version = "([^"]+)"$/gm, 1);
checkCaptures("shim/rust/Cargo.lock", /^name = "toard-shim"\nversion = "([^"]+)"$/gm, 1);
checkCaptures("helm/toard/Chart.yaml", /^version:\s*"?([^"\s]+)"?$/gm, 1);
checkCaptures("helm/toard/Chart.yaml", /^appVersion:\s*"?([^"\s]+)"?$/gm, 1);
checkCaptures("helm/toard/values.yaml", /^\s+tag:\s*([^\s#]+)$/gm, 3);
checkCaptures("k8s/base/deployment.yaml", /^\s+image:\s*toard(?:-migrate)?:([^\s#]+)$/gm, 2);
checkCaptures("k8s/kustomization.yaml", /^\s+newTag:\s*([^\s#]+)$/gm, 2);
checkCaptures("k8s/migrate-job.yaml", /^\s+image:\s*toard-migrate:([^\s#]+).*$/gm, 1);
checkCaptures("k8s/overlays/orbstack-personal/kustomization.yaml", /^\s+newTag:\s*([^\s#]+)$/gm, 2);

if (failures.length > 0) {
  console.error(["release version contract failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  process.exit(1);
}

console.log(`release version contract OK: ${expected}`);
