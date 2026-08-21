import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflows = [
  ".github/workflows/docker-publish.yml",
  ".github/workflows/shim-release.yml",
];

for (const workflow of workflows) {
  test(`${workflow}는 무접두 semver만 릴리스하고 v* 태그를 제외한다`, () => {
    const source = readFileSync(new URL(`../${workflow}`, import.meta.url), "utf8");
    assert.match(source, /- "\*\.\*\.\*"/);
    assert.match(source, /- "!v\*"/);
    assert.doesNotMatch(source, /GITHUB_REF_NAME#v|refs\/tags\/v/);
    assert.doesNotMatch(source, /NPM_TOKEN|npm publish|@toard\/shim/);
  });
}
