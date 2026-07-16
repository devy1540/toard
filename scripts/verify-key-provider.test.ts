import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyKeyProvider } from "./verify-key-provider";
import type {
  KeyManagementProvider,
  KeyProviderHealth,
} from "../apps/web/lib/key-management/types";

test("verify script는 opt-in이 아니면 config/provider 접근 전에 exit 2한다", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/verify-key-provider.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOARD_VERIFY_KEY_PROVIDER: "0",
        TOARD_KEY_ACTIVE_PROVIDER: "local",
        TOARD_KEY_ACTIVE_LOCAL_KEK_FILE: "/definitely/must/not/be/read",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "TOARD_VERIFY_KEY_PROVIDER=1 required");
});

test("verify script는 opt-in 미설정도 동일하게 exit 2한다", () => {
  const env = { ...process.env };
  delete env.TOARD_VERIFY_KEY_PROVIDER;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/verify-key-provider.ts"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), "TOARD_VERIFY_KEY_PROVIDER=1 required");
});

test("unhealthy canary는 detail 없는 제한된 JSON과 exit 1만 반환한다", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const provider = {
    name: "aws-kms",
    keyRef: "arn:aws:kms:ap-northeast-2:123456789012:key/test",
    fingerprint: "aws-kms:test",
  } as KeyManagementProvider;
  const result = await verifyKeyProvider(
    { TOARD_VERIFY_KEY_PROVIDER: "1" },
    {
      load: async () => ({
        loadKeyManagementConfig: () => ({
          active: {
            slot: "active",
            provider: "aws-kms",
            settings: {},
          },
          migration: null,
          cacheTtlMs: 1,
        }),
        createKeyProvider: () => provider,
        runProviderCanary: async (): Promise<KeyProviderHealth> => ({
          status: "unhealthy",
          latencyMs: 12.6,
          checkedAt: new Date(0),
          errorCode: "secret remote response",
        }),
      }),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );

  assert.equal(result, 1);
  assert.deepEqual(stderr, []);
  assert.deepEqual(JSON.parse(stdout[0]!), {
    provider: provider.name,
    keyRef: provider.keyRef,
    fingerprint: provider.fingerprint,
    status: "unhealthy",
    latencyMs: 13,
  });
  assert.equal(stdout[0]!.includes("secret remote response"), false);
});
