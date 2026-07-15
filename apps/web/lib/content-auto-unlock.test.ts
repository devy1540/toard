import assert from "node:assert/strict";
import test from "node:test";
import { unlockApprovedBrowser } from "./content-auto-unlock";

test("stored approved device unwraps UCK without an approval request", async () => {
  const uck = new Uint8Array(32).fill(7);
  const keyPair = {} as CryptoKeyPair;
  const result = await unlockApprovedBrowser({
    loadDevice: async () => ({ id: "active", serverDeviceId: "device-1", keyPair }),
    loadWrapper: async () => ({
      wrapperType: "device", wrapperRef: "device-1", contentKeyVersion: 1,
      kdfVersion: "hpke-p256-v1", publicSaltOrInput: null, nonce: null, authTag: null,
      encapsulatedKey: "enc", wrappedContentKey: "wrapped",
    }),
    openEnvelope: async () => uck,
  });
  assert.deepEqual(result, { deviceId: "device-1", uck });
});

test("missing local device does not create an approval", async () => {
  const result = await unlockApprovedBrowser({
    loadDevice: async () => null,
    loadWrapper: async () => { throw new Error("not called"); },
    openEnvelope: async () => { throw new Error("not called"); },
  });
  assert.equal(result, null);
});
