import { createHash } from "node:crypto";
import type { ToolDeploymentStatus } from "@toard/core";
import type { IngestAuthResult } from "./ingest-auth";
import { readBoundedJson } from "./tool-ingest";
import {
  DeploymentClientError,
  type DeviceManifestV1,
} from "./tool-deployment-service";
import type { DeploymentReportInput } from "./tool-deployment-repository";

const MAX_REPORT_BYTES = 256 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;
const REPORT_KEYS = new Set([
  "deviceFingerprint",
  "catalogItemId",
  "desiredVersionId",
  "appliedVersionId",
  "status",
  "errorCode",
  "attempt",
  "rolloutId",
]);
const STATUSES = new Set<ToolDeploymentStatus>([
  "queued",
  "applying",
  "settings_required",
  "installed",
  "conflict",
  "failed",
  "rolled_back",
  "excluded",
  "unsupported",
]);

export type ToolDeploymentApiDependencies = {
  authenticate(authHeader: string | null): Promise<IngestAuthResult | null>;
  buildManifest(
    owner: IngestAuthResult,
    input: { fingerprint: string; protocol: number },
  ): Promise<DeviceManifestV1>;
  deviceBelongsToToken(owner: IngestAuthResult, fingerprint: string): Promise<boolean>;
  saveReport(owner: IngestAuthResult, report: DeploymentReportInput): Promise<void>;
};

function jsonError(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

function stableManifestEtag(manifest: DeviceManifestV1): string {
  const stable = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    reconcileAfterSeconds: manifest.reconcileAfterSeconds,
    items: manifest.items,
  });
  return `"${createHash("sha256").update(stable).digest("hex")}"`;
}

export async function getDeviceManifestResponse(
  request: Request,
  dependencies: ToolDeploymentApiDependencies,
): Promise<Response> {
  const owner = await dependencies.authenticate(request.headers.get("authorization"));
  if (!owner) return jsonError("unauthorized", 401);
  const url = new URL(request.url);
  try {
    const manifest = await dependencies.buildManifest(owner, {
      fingerprint: url.searchParams.get("fingerprint") ?? "",
      protocol: Number(request.headers.get("x-toard-tool-protocol")),
    });
    const etag = stableManifestEtag(manifest);
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } });
    }
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json", etag, "cache-control": "private, no-cache" },
    });
  } catch (error) {
    if (error instanceof DeploymentClientError) return jsonError(error.code, error.status);
    throw error;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 200);
}

export function parseDeploymentReport(value: unknown): DeploymentReportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("invalid_report");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== REPORT_KEYS.size || Object.keys(record).some((key) => !REPORT_KEYS.has(key))) {
    throw new SyntaxError("invalid_report_fields");
  }
  if (!FINGERPRINT.test(String(record.deviceFingerprint ?? ""))) throw new SyntaxError("invalid_fingerprint");
  if (typeof record.catalogItemId !== "string" || !record.catalogItemId || record.catalogItemId.length > 200) throw new SyntaxError("invalid_catalog_item");
  if (!isNullableString(record.desiredVersionId) || !isNullableString(record.appliedVersionId) || !isNullableString(record.rolloutId)) throw new SyntaxError("invalid_identifier");
  if (typeof record.status !== "string" || !STATUSES.has(record.status as ToolDeploymentStatus)) throw new SyntaxError("invalid_status");
  if (record.errorCode !== null && (typeof record.errorCode !== "string" || !ERROR_CODE.test(record.errorCode))) throw new SyntaxError("invalid_error_code");
  if (!Number.isSafeInteger(record.attempt) || Number(record.attempt) < 0) throw new SyntaxError("invalid_attempt");
  return {
    deviceFingerprint: record.deviceFingerprint as string,
    catalogItemId: record.catalogItemId,
    desiredVersionId: record.desiredVersionId,
    appliedVersionId: record.appliedVersionId,
    status: record.status as ToolDeploymentStatus,
    errorCode: record.errorCode as string | null,
    attempt: record.attempt as number,
    rolloutId: record.rolloutId,
  };
}

export async function postDeploymentReportResponse(
  request: Request,
  dependencies: ToolDeploymentApiDependencies,
): Promise<Response> {
  const owner = await dependencies.authenticate(request.headers.get("authorization"));
  if (!owner) return jsonError("unauthorized", 401);
  try {
    const report = parseDeploymentReport(await readBoundedJson(request, MAX_REPORT_BYTES));
    if (!(await dependencies.deviceBelongsToToken(owner, report.deviceFingerprint))) {
      return jsonError("device_not_owned", 403);
    }
    await dependencies.saveReport(owner, report);
    return Response.json({ accepted: true }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RangeError) return jsonError("body_too_large", 413);
    if (error instanceof SyntaxError) return jsonError(error.message, 400);
    throw error;
  }
}
