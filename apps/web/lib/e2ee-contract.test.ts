import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalContentAad,
  fromBase64Url,
  parseContentDevice,
  parseContentKeyWrapper,
  parseDeviceEnvelope,
  parseE2eePromptRecordsBody,
} from "./e2ee-contract";
import {
  VALID_BROWSER,
  VALID_DEVICE_ENVELOPE,
  VALID_DEVICE_WRAPPER,
  VALID_E2EE_RECORD,
  VALID_RECOVERY_WRAPPER,
} from "./e2ee-test-fixtures";

test("e2ee wire rejects plaintext fields", () => {
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, text: "secret" }]),
    /허용되지 않은 필드: text/,
  );
});

test("e2ee wire fixes schema, algorithm, aad version, and key version", () => {
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, algorithm: "AES-128-GCM" }]),
    /algorithm은 AES-256-GCM/,
  );
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, aadVersion: 2 }]),
    /aadVersion은 1/,
  );
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, contentKeyVersion: 0 }]),
    /contentKeyVersion은 1 이상/,
  );
});

test("e2ee wire validates batch and decoded byte lengths", () => {
  assert.throws(() => parseE2eePromptRecordsBody({}), /배열/);
  assert.throws(
    () => parseE2eePromptRecordsBody(Array.from({ length: 1_001 }, () => VALID_E2EE_RECORD)),
    /최대 1000건/,
  );
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, iv: Buffer.alloc(11).toString("base64url") }]),
    /iv는 12바이트/,
  );
  assert.throws(
    () => parseE2eePromptRecordsBody([{ ...VALID_E2EE_RECORD, ciphertext: "" }]),
    /ciphertext는 1바이트 이상/,
  );
});

test("AAD v1 is deterministic and binds owner and metadata", () => {
  const aad = canonicalContentAad({
    schema: "e2ee_v1",
    contentOwnerId: "018f47d0-4d47-7b04-950b-7d18a86e1b43",
    dedupKey: "abc",
    providerKey: "codex",
    turnRole: "user",
    ts: "2026-07-14T00:00:00.000Z",
  });
  assert.equal(
    new TextDecoder().decode(aad),
    '{"schema":"e2ee_v1","contentOwnerId":"018f47d0-4d47-7b04-950b-7d18a86e1b43","dedupKey":"abc","providerKey":"codex","turnRole":"user","ts":"2026-07-14T00:00:00.000Z"}',
  );
});

test("TypeScript AAD matches the shared Rust golden vector", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), "../../fixtures/e2ee-v1-golden.json"), "utf8"),
  ) as { metadata: Parameters<typeof canonicalContentAad>[0]; aad: string };
  assert.equal(Buffer.from(canonicalContentAad(fixture.metadata)).toString("base64url"), fixture.aad);
});

test("base64url parser rejects non-canonical encodings", () => {
  assert.deepEqual(fromBase64Url(Buffer.from("abc").toString("base64url"), "value"), Buffer.from("abc"));
  assert.throws(() => fromBase64Url("YWJj=", "value"), /base64url/);
  assert.throws(() => fromBase64Url("%%%", "value"), /base64url/);
});

test("device and wrapper contracts reject incompatible shapes", () => {
  assert.deepEqual(parseContentDevice(VALID_BROWSER), VALID_BROWSER);
  assert.deepEqual(parseDeviceEnvelope(VALID_DEVICE_ENVELOPE), VALID_DEVICE_ENVELOPE);
  assert.deepEqual(parseContentKeyWrapper(VALID_DEVICE_WRAPPER), VALID_DEVICE_WRAPPER);
  assert.deepEqual(parseContentKeyWrapper(VALID_RECOVERY_WRAPPER), VALID_RECOVERY_WRAPPER);
  assert.throws(
    () => parseContentKeyWrapper({ ...VALID_DEVICE_WRAPPER, nonce: Buffer.alloc(12).toString("base64url") }),
    /device wrapper의 nonce는 null/,
  );
  assert.throws(
    () => parseContentKeyWrapper({ ...VALID_RECOVERY_WRAPPER, encapsulatedKey: Buffer.alloc(65).toString("base64url") }),
    /recovery wrapper의 encapsulatedKey는 null/,
  );
});
