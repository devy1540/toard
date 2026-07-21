import { createHash } from "node:crypto";
import type {
  ToolDeploymentManifestV1,
  ToolDeploymentPayload,
  ToolDeploymentPermissions,
} from "@toard/core";

export type SourceFile = { path: string; bytes: Uint8Array };

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const EXECUTABLE = /^[A-Za-z0-9._+-]+$/;
const MANAGED_KEY = /^[A-Za-z0-9._-]{1,200}$/;
const PINNED_NPM_PACKAGE = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i;
const SHELL_TRAMPOLINES = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "pwsh", "powershell", "powershell.exe"]);

export function normalizeSafeRelativePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes("//")
  ) {
    throw new Error("unsafe source path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("unsafe source path");
  }
  return segments.join("/");
}

function updateLengthFramed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  hash.update(String(value.byteLength));
  hash.update(":");
  hash.update(value);
  hash.update(":");
}

export function canonicalTreeDigest(files: readonly SourceFile[]): string {
  const normalized = files.map((file) => ({ ...file, path: normalizeSafeRelativePath(file.path) }));
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  if (normalized.some((file, index) => index > 0 && normalized[index - 1]?.path === file.path)) {
    throw new Error("duplicate source path");
  }
  const hash = createHash("sha256");
  for (const file of normalized) {
    updateLengthFramed(hash, Buffer.from(file.path, "utf8"));
    updateLengthFramed(hash, file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function permissionFingerprint(permissions: ToolDeploymentPermissions): string {
  const canonical = JSON.stringify({
    env: sortedUnique(permissions.env),
    networkHosts: sortedUnique(permissions.networkHosts),
    executables: sortedUnique(permissions.executables),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validateHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ${label} URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`invalid ${label} URL`);
  return url;
}

function validatePermissions(value: ToolDeploymentPermissions): void {
  if (value.env.some((name) => !ENV_NAME.test(name))) throw new Error("invalid environment name");
  if (value.networkHosts.some((host) => !HOST.test(host))) throw new Error("invalid network host");
  if (value.executables.some((command) => !EXECUTABLE.test(command))) throw new Error("invalid executable");
}

function validatePayload(payload: ToolDeploymentPayload): void {
  if (payload.type === "skill") {
    const files = payload.files.map(normalizeSafeRelativePath);
    if (!files.includes("SKILL.md")) throw new Error("Skill manifest requires SKILL.md");
    if (!MANAGED_KEY.test(payload.targetKey)) throw new Error("invalid managed key");
    return;
  }
  if (payload.type === "mcp_stdio") {
    if (!EXECUTABLE.test(payload.command)) throw new Error("invalid command");
    if (SHELL_TRAMPOLINES.has(payload.command.toLowerCase())) throw new Error("shell command is not allowed");
    if (payload.args.some((arg) => arg.includes("\0") || arg.length > 2_000)) throw new Error("invalid command argument");
    if (payload.command === "npx" && !payload.args.some((arg) => PINNED_NPM_PACKAGE.test(arg))) {
      throw new Error("npx requires a pinned package version");
    }
    if (payload.requiredEnvNames.some((name) => !ENV_NAME.test(name))) throw new Error("invalid environment name");
    if (!MANAGED_KEY.test(payload.managedKey)) throw new Error("invalid managed key");
    return;
  }
  if (payload.type === "mcp_http") {
    validateHttpsUrl(payload.url, "MCP");
    if (!MANAGED_KEY.test(payload.managedKey)) throw new Error("invalid managed key");
    return;
  }
  const keys = payload.components.map((component) => `${component.type}:${component.key}`);
  if (keys.some((key) => !MANAGED_KEY.test(key.split(":")[1] ?? "")) || new Set(keys).size !== keys.length) {
    throw new Error("invalid plugin component");
  }
}

export function validateInstallManifest(value: ToolDeploymentManifestV1): ToolDeploymentManifestV1 {
  if (value.schemaVersion !== 1 || value.minProtocolVersion !== 1) throw new Error("unsupported manifest schema");
  if (!REPOSITORY.test(value.source.repository) || !COMMIT_SHA.test(value.source.exactRef)) {
    throw new Error("source must use repository identity and exact commit");
  }
  if (value.source.path) normalizeSafeRelativePath(value.source.path);
  if (!DIGEST.test(value.source.treeDigest)) throw new Error("invalid source digest");
  validateHttpsUrl(value.source.downloadUrl, "download");
  if (value.clients.length === 0 || new Set(value.clients).size !== value.clients.length) {
    throw new Error("manifest requires unique clients");
  }
  validatePermissions(value.permissions);
  validatePayload(value.payload);
  if (value.payload.type === "skill" && value.kind !== "skill") throw new Error("kind and payload mismatch");
  if ((value.payload.type === "mcp_stdio" || value.payload.type === "mcp_http") && value.kind !== "mcp") {
    throw new Error("kind and payload mismatch");
  }
  if (value.payload.type === "plugin" && value.kind !== "plugin") throw new Error("kind and payload mismatch");
  if (
    value.payload.type === "mcp_stdio" &&
    value.payload.requiredEnvNames.some((name) => !value.permissions.env.includes(name))
  ) {
    throw new Error("required environment name missing from permissions");
  }
  return value;
}
