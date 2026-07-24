import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceToolInventory } from "@toard/core";
import type { DeviceControlView } from "./device-control-repository";
import { buildSettingsDeviceRows } from "./settings-device-rows";

function inventory(fingerprint: string, host = "shared-host"): DeviceToolInventory {
  return {
    tokenId: "token-1",
    host,
    fingerprint,
    observedAt: new Date("2026-07-24T00:00:00.000Z"),
    receivedAt: new Date("2026-07-24T00:00:00.000Z"),
    items: [],
  };
}

test("설정 기기 행은 hostname이 같아도 fingerprint별로 분리한다", () => {
  const rows = buildSettingsDeviceRows(
    [
      {
        host: "shared-host",
        eventCount: 7,
        lastSeenAt: new Date("2026-07-24T00:00:00.000Z"),
      },
    ],
    [inventory("a".repeat(64)), inventory("b".repeat(64))],
    [],
  );

  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.key, rows[1]!.key);
  assert.equal(rows[0]!.sharedHost, true);
  assert.equal(rows[1]!.sharedHost, true);
});

test("제어 동기화가 보고한 최신 hostname을 fingerprint 행에 반영한다", () => {
  const control: DeviceControlView = {
    tokenId: "token-1",
    deviceFingerprint: "a".repeat(64),
    host: "renamed-host",
    desiredGeneration: 1,
    desiredContentMode: "off",
    appliedGeneration: 1,
    appliedContentMode: "off",
    shimVersion: "0.15.51",
    daemonActive: true,
    lastSyncAt: new Date("2026-07-24T00:00:00.000Z"),
    errorCode: null,
    command: null,
  };

  const rows = buildSettingsDeviceRows(
    [{
      host: "renamed-host",
      eventCount: 3,
      lastSeenAt: new Date("2026-07-24T00:00:00.000Z"),
    }],
    [inventory("a".repeat(64), "old-host")],
    [control],
  );

  assert.equal(rows[0]!.host, "renamed-host");
  assert.equal(rows[0]!.device?.eventCount, 3);
});
