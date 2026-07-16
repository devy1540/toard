const HTTP_HEADER_VALUE_MAX_BYTES = 4_096;
const TRANSIT_NAMESPACE_MAX_BYTES = 512;
const TRANSIT_IDENTITY_MAX_BYTES = 512;
const TRANSIT_SECRET_MAX_BYTES = 16_384;
const TRANSIT_MOUNT_MAX_BYTES = 1_024;
const TRANSIT_PATH_SEGMENT_MAX_BYTES = 128;
const TRANSIT_CIPHERTEXT_MAX_BYTES = 16_384;
const CONTROL_OR_DEL = /[\u0000-\u001f\u007f]/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isExactTrimmed(value: string): boolean {
  return value !== "" && value === value.trim();
}

function isStrictBase64(value: string): boolean {
  if (
    value === ""
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function isSafeHttpFieldValue(
  value: string,
  maxBytes = HTTP_HEADER_VALUE_MAX_BYTES,
): boolean {
  return (
    isExactTrimmed(value)
    && !CONTROL_OR_DEL.test(value)
    && byteLength(value) <= maxBytes
  );
}

export function normalizeFileToken(value: string): string {
  const normalized = value.trim();
  if (!isSafeHttpFieldValue(normalized)) {
    throw new Error("TRANSIT_TOKEN_INVALID");
  }
  return normalized;
}

export function isSafeTransitToken(value: string): boolean {
  return isSafeHttpFieldValue(value);
}

export function isSafeTransitNamespace(value: string): boolean {
  return isSafeHttpFieldValue(value, TRANSIT_NAMESPACE_MAX_BYTES);
}

export function isSafeTransitIdentity(value: string): boolean {
  return (
    isExactTrimmed(value)
    && !CONTROL_OR_DEL.test(value)
    && byteLength(value) <= TRANSIT_IDENTITY_MAX_BYTES
  );
}

export function normalizeSecretValue(value: string): string {
  const normalized = value.trim();
  if (
    normalized === ""
    || CONTROL_OR_DEL.test(normalized)
    || byteLength(normalized) > TRANSIT_SECRET_MAX_BYTES
  ) {
    throw new Error("TRANSIT_SECRET_VALUE_INVALID");
  }
  return normalized;
}

function validatePathSegment(value: string): string {
  if (
    value === ""
    || value === "."
    || value === ".."
    || value.includes("\\")
    || value.includes("%")
    || /\s/.test(value)
    || CONTROL_OR_DEL.test(value)
    || byteLength(value) > TRANSIT_PATH_SEGMENT_MAX_BYTES
  ) {
    throw new Error("TRANSIT_PATH_INVALID");
  }
  return encodeURIComponent(value);
}

export function canonicalTransitMount(value: string): string {
  if (
    value === ""
    || value !== value.trim()
    || byteLength(value) > TRANSIT_MOUNT_MAX_BYTES
  ) {
    throw new Error("TRANSIT_PATH_INVALID");
  }
  return value.split("/").map(validatePathSegment).join("/");
}

export function canonicalTransitKeyName(value: string): string {
  if (value.includes("/")) throw new Error("TRANSIT_PATH_INVALID");
  return validatePathSegment(value);
}

export function isTransitCiphertext(value: string): boolean {
  if (
    byteLength(value) > TRANSIT_CIPHERTEXT_MAX_BYTES
    || CONTROL_OR_DEL.test(value)
  ) {
    return false;
  }
  const match = /^vault:v([1-9]\d*):(.+)$/.exec(value);
  if (!match) return false;
  const version = Number(match[1]);
  return (
    Number.isSafeInteger(version)
    && version > 0
    && isStrictBase64(match[2]!)
  );
}
