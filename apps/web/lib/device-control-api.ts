import type { IngestAuthResult } from "./ingest-auth";
import { sanitizeHost } from "./sanitize";
import { readBoundedJson } from "./tool-ingest";
import type {
  DeviceControlContentMode,
  DeviceControlObservationInput,
  DeviceControlSyncResult,
} from "./device-control-repository";

const MAX_SYNC_BYTES = 64 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;
const ROOT_KEYS = new Set([
  "schemaVersion",
  "deviceFingerprint",
  "host",
  "shimVersion",
  "daemonActive",
  "appliedGeneration",
  "appliedContentMode",
  "appliedContentSince",
  "errorCode",
  "commandResults",
]);
const RESULT_KEYS = new Set(["commandId", "status", "resultCode"]);

export type DeviceControlApiDependencies = {
  authenticate(authHeader: string | null): Promise<IngestAuthResult | null>;
  sync(
    owner: IngestAuthResult,
    observation: DeviceControlObservationInput,
  ): Promise<DeviceControlSyncResult | null>;
};

function jsonError(code: string, status: number): Response {
  return Response.json(
    { error: code },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function exactKeys(record: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function contentMode(value: unknown): value is DeviceControlContentMode {
  return value === "off" || value === "server_v1" || value === "e2ee_v1";
}

function nullableDate(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) throw new SyntaxError("invalid_timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new SyntaxError("invalid_timestamp");
  return parsed;
}

function nullableErrorCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ERROR_CODE.test(value)) {
    throw new SyntaxError("invalid_error_code");
  }
  return value;
}

export function parseDeviceControlSync(value: unknown): DeviceControlObservationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("invalid_sync");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ROOT_KEYS)) throw new SyntaxError("invalid_sync_fields");
  if (record.schemaVersion !== 1) throw new SyntaxError("unsupported_protocol");
  if (typeof record.deviceFingerprint !== "string" || !FINGERPRINT.test(record.deviceFingerprint)) {
    throw new SyntaxError("invalid_fingerprint");
  }
  if (record.host !== null && (typeof record.host !== "string" || record.host.length > 255)) {
    throw new SyntaxError("invalid_host");
  }
  if (typeof record.shimVersion !== "string" || !VERSION.test(record.shimVersion)) {
    throw new SyntaxError("invalid_shim_version");
  }
  if (typeof record.daemonActive !== "boolean") throw new SyntaxError("invalid_daemon_state");
  if (!Number.isSafeInteger(record.appliedGeneration) || Number(record.appliedGeneration) < 0) {
    throw new SyntaxError("invalid_generation");
  }
  if (!contentMode(record.appliedContentMode)) throw new SyntaxError("invalid_content_mode");
  if (!Array.isArray(record.commandResults) || record.commandResults.length > 32) {
    throw new SyntaxError("invalid_command_results");
  }
  const seen = new Set<string>();
  const commandResults = record.commandResults.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SyntaxError("invalid_command_result");
    }
    const result = value as Record<string, unknown>;
    if (!exactKeys(result, RESULT_KEYS)) throw new SyntaxError("invalid_command_result_fields");
    if (typeof result.commandId !== "string" || !UUID.test(result.commandId) || seen.has(result.commandId)) {
      throw new SyntaxError("invalid_command_id");
    }
    if (result.status !== "succeeded" && result.status !== "failed") {
      throw new SyntaxError("invalid_command_status");
    }
    const status: "succeeded" | "failed" = result.status;
    seen.add(result.commandId);
    return {
      commandId: result.commandId,
      status,
      resultCode: nullableErrorCode(result.resultCode),
    };
  });
  return {
    deviceFingerprint: record.deviceFingerprint,
    host: sanitizeHost(record.host),
    shimVersion: record.shimVersion,
    daemonActive: record.daemonActive,
    appliedGeneration: Number(record.appliedGeneration),
    appliedContentMode: record.appliedContentMode,
    appliedContentSince: nullableDate(record.appliedContentSince),
    errorCode: nullableErrorCode(record.errorCode),
    commandResults,
  };
}

export async function postDeviceControlSyncResponse(
  request: Request,
  dependencies: DeviceControlApiDependencies,
): Promise<Response> {
  const owner = await dependencies.authenticate(request.headers.get("authorization"));
  if (!owner) return jsonError("unauthorized", 401);
  try {
    const observation = parseDeviceControlSync(await readBoundedJson(request, MAX_SYNC_BYTES));
    const result = await dependencies.sync(owner, observation);
    if (!result) return jsonError("device_not_owned", 403);
    return Response.json(
      {
        schemaVersion: 1,
        desired: {
          generation: result.desired.generation,
          contentMode: result.desired.contentMode,
          contentSince: result.desired.contentSince?.toISOString() ?? null,
        },
        commands: result.commands,
        nextSyncSeconds: 60,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RangeError) return jsonError("body_too_large", 413);
    if (error instanceof SyntaxError) {
      const status = error.message === "unsupported_protocol" ? 426 : 400;
      return jsonError(error.message, status);
    }
    throw error;
  }
}
