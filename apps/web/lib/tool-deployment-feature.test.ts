import assert from "node:assert/strict";
import test from "node:test";
import { toolDeploymentExperimentalEnabled } from "./tool-deployment-feature";

test("도구 자동 배포는 명시적으로 1을 설정한 서버에서만 활성화된다", () => {
  assert.equal(toolDeploymentExperimentalEnabled({}), false);
  assert.equal(toolDeploymentExperimentalEnabled({ TOARD_TOOL_DEPLOYMENT_EXPERIMENTAL: "0" }), false);
  assert.equal(toolDeploymentExperimentalEnabled({ TOARD_TOOL_DEPLOYMENT_EXPERIMENTAL: "true" }), false);
  assert.equal(toolDeploymentExperimentalEnabled({ TOARD_TOOL_DEPLOYMENT_EXPERIMENTAL: "1" }), true);
});
