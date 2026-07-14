import type { ContentKeyWrapperWire, DeviceEnvelopeWire } from "./e2ee-contract";
import type { StoredBrowserDevice } from "./content-key-vault";

type AutoUnlockDeps = {
  loadDevice(): Promise<StoredBrowserDevice | null>;
  loadWrapper(deviceId: string): Promise<ContentKeyWrapperWire>;
  openEnvelope(keyPair: CryptoKeyPair, envelope: DeviceEnvelopeWire): Promise<Uint8Array<ArrayBuffer>>;
};

export async function unlockApprovedBrowser(deps: AutoUnlockDeps): Promise<{
  deviceId: string;
  uck: Uint8Array<ArrayBuffer>;
} | null> {
  const device = await deps.loadDevice();
  if (!device) return null;
  const wrapper = await deps.loadWrapper(device.serverDeviceId);
  if (!wrapper.encapsulatedKey) throw new Error("DEVICE_WRAPPER_INVALID");
  const uck = await deps.openEnvelope(device.keyPair, {
    algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
    encapsulatedKey: wrapper.encapsulatedKey,
    ciphertext: wrapper.wrappedContentKey,
  });
  return { deviceId: device.serverDeviceId, uck };
}
