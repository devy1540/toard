import test from "node:test";
import assert from "node:assert/strict";
import {
  dockerComposeArgs,
  initialStatus,
  normalizeTargetVersion,
  parseLatestVersionFromLocation,
  updateEnvContent,
} from "../src/server.mjs";

test("parseLatestVersionFromLocation accepts GitHub release redirects", () => {
  assert.equal(
    parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases/tag/v1.2.3"),
    "1.2.3",
  );
  assert.equal(
    parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases/tag/1.2.3"),
    "1.2.3",
  );
  assert.equal(parseLatestVersionFromLocation("https://github.com/devy1540/toard/releases"), null);
});

test("normalizeTargetVersion returns docker image semver tags", () => {
  assert.equal(normalizeTargetVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeTargetVersion("1.2.3"), "1.2.3");
  assert.equal(normalizeTargetVersion("latest"), null);
  assert.equal(normalizeTargetVersion(""), null);
  assert.throws(() => normalizeTargetVersion("main"), /targetVersion/);
});

test("dockerComposeArgs always scopes commands to the configured compose file", () => {
  assert.deepEqual(dockerComposeArgs(["pull", "app"]), ["compose", "-f", "docker-compose.yml", "pull", "app"]);
});

test("updateEnvContent replaces or appends TOARD_TAG without touching comments", () => {
  assert.equal(updateEnvContent("AUTH_SECRET=keep\nTOARD_TAG=0.10.1\n", "TOARD_TAG", "0.11.0"), "AUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
  assert.equal(updateEnvContent("# TOARD_TAG=0.10.1\nAUTH_SECRET=keep\n", "TOARD_TAG", "0.11.0"), "# TOARD_TAG=0.10.1\nAUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
  assert.equal(updateEnvContent("AUTH_SECRET=keep", "TOARD_TAG", "0.11.0"), "AUTH_SECRET=keep\nTOARD_TAG=0.11.0\n");
});

test("initialStatus is idle and serializable", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(initialStatus())), {
    running: false,
    phase: "idle",
    message: "idle",
    currentVersion: null,
    latestVersion: null,
    targetVersion: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    logs: [],
  });
});
