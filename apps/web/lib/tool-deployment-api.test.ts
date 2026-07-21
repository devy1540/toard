import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDeploymentManifestV1 } from "@toard/core";
import {
  getDeviceManifestResponse,
  postDeploymentReportResponse,
  type ToolDeploymentApiDependencies,
} from "./tool-deployment-api";

const fingerprint = "a".repeat(64);
const manifest: ToolDeploymentManifestV1 = {
  schemaVersion: 1,
  catalogItemId: "catalog-1",
  versionId: "version-1",
  slug: "review",
  kind: "skill",
  source: { provider: "github", repository: "acme/review", exactRef: "b".repeat(40), path: "", treeDigest: `sha256:${"c".repeat(64)}`, downloadUrl: "https://github.com/acme/review/archive/a.tar.gz" },
  clients: ["codex"],
  minProtocolVersion: 1,
  permissions: { env: [], networkHosts: [], executables: [] },
  payload: { type: "skill", files: ["SKILL.md"], targetKey: "review" },
};

function dependencies(): ToolDeploymentApiDependencies & { reports: unknown[] } {
  const reports: unknown[] = [];
  return {
    reports,
    async authenticate() {
      return { userId: "user-1", tokenId: "token-1" };
    },
    async buildManifest() {
      return {
        schemaVersion: 1,
        generatedAt: new Date("2026-07-15T00:00:00Z"),
        reconcileAfterSeconds: 60,
        items: [{ catalogItemId: "catalog-1", versionId: "version-1", origin: "personal", rolloutId: null, manifest }],
      };
    },
    async deviceBelongsToToken(_owner, value) {
      return value === fingerprint;
    },
    async reportMatchesDesiredState(_owner, report) {
      return report.catalogItemId === "catalog-1" &&
        report.desiredVersionId === "version-1" &&
        report.rolloutId === null;
    },
    async saveReport(_owner, report) {
      reports.push(report);
    },
  };
}

function manifestRequest(etag?: string): Request {
  return new Request(`http://localhost/api/v1/tool-deployment/manifest?fingerprint=${fingerprint}`, {
    headers: {
      authorization: "Bearer token",
      "x-toard-tool-protocol": "1",
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });
}

test("manifest API는 private no-cache ETag와 304를 제공한다", async () => {
  const deps = dependencies();
  const first = await getDeviceManifestResponse(manifestRequest(), deps);
  const etag = first.headers.get("etag");

  assert.equal(first.status, 200);
  assert.match(etag ?? "", /^"[a-f0-9]{64}"$/);
  assert.equal(first.headers.get("cache-control"), "private, no-cache");

  const second = await getDeviceManifestResponse(manifestRequest(etag ?? undefined), deps);
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("report API는 unknown key와 비밀값 필드를 body 단계에서 거부한다", async () => {
  const deps = dependencies();
  const response = await postDeploymentReportResponse(
    new Request("http://localhost/api/v1/tool-deployment/reports", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        deviceFingerprint: fingerprint,
        catalogItemId: "catalog-1",
        desiredVersionId: "version-1",
        appliedVersionId: null,
        status: "settings_required",
        errorCode: "local_secret_missing",
        attempt: 1,
        rolloutId: null,
        env: { TOKEN: "secret" },
      }),
    }),
    deps,
  );

  assert.equal(response.status, 400);
  assert.equal(deps.reports.length, 0);
});

test("report API는 token 소유 기기만 비밀값 없는 닫힌 상태를 저장한다", async () => {
  const deps = dependencies();
  const body = {
    deviceFingerprint: fingerprint,
    catalogItemId: "catalog-1",
    desiredVersionId: "version-1",
    appliedVersionId: "version-1",
    status: "installed",
    errorCode: null,
    attempt: 1,
    rolloutId: null,
  };
  const accepted = await postDeploymentReportResponse(
    new Request("http://localhost/api/v1/tool-deployment/reports", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    deps,
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(deps.reports, [body]);

  const forbidden = await postDeploymentReportResponse(
    new Request("http://localhost/api/v1/tool-deployment/reports", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ ...body, deviceFingerprint: "d".repeat(64) }),
    }),
    deps,
  );
  assert.equal(forbidden.status, 403);
});

test("report API는 현재 기기에 발급되지 않은 catalog/version/rollout 조합을 거부한다", async () => {
  const deps = dependencies();
  const response = await postDeploymentReportResponse(
    new Request("http://localhost/api/v1/tool-deployment/reports", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        deviceFingerprint: fingerprint,
        catalogItemId: "forged-item",
        desiredVersionId: "version-1",
        appliedVersionId: null,
        status: "failed",
        errorCode: "health_check_failed",
        attempt: 1,
        rolloutId: null,
      }),
    }),
    deps,
  );
  assert.equal(response.status, 409);
  assert.equal(deps.reports.length, 0);
});
