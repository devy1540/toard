import type { DeviceInfo, DeviceToolInventory } from "@toard/core";
import type { DeviceControlView } from "./device-control-repository";

export type SettingsDeviceRow = {
  key: string;
  host: string | null;
  device: DeviceInfo | null;
  inventory: DeviceToolInventory | null;
  control: DeviceControlView | null;
  sharedHost: boolean;
};

function controlKey(tokenId: string, fingerprint: string): string {
  return `${tokenId}:${fingerprint}`;
}

export function buildSettingsDeviceRows(
  devices: DeviceInfo[],
  inventories: DeviceToolInventory[],
  controls: DeviceControlView[],
): SettingsDeviceRow[] {
  const deviceByHost = new Map(devices.map((device) => [device.host, device]));
  const controlByDevice = new Map(
    controls.map((control) => [
      controlKey(control.tokenId, control.deviceFingerprint),
      control,
    ]),
  );
  const inventoryRows = inventories.map((inventory) => {
    const key = controlKey(inventory.tokenId, inventory.fingerprint);
    const control = controlByDevice.get(key) ?? null;
    return { key, host: control?.host ?? inventory.host, inventory, control };
  });
  const inventoryHostCounts = new Map<string | null, number>();
  for (const row of inventoryRows) {
    inventoryHostCounts.set(row.host, (inventoryHostCounts.get(row.host) ?? 0) + 1);
  }

  const rows: SettingsDeviceRow[] = inventoryRows.map((row) => ({
    ...row,
    device: deviceByHost.get(row.host) ?? null,
    sharedHost: (inventoryHostCounts.get(row.host) ?? 0) > 1,
  }));
  const inventoryHosts = new Set(inventoryRows.map((row) => row.host));
  for (const device of devices) {
    if (inventoryHosts.has(device.host)) continue;
    rows.push({
      key: `legacy:${device.host ?? "__unknown__"}`,
      host: device.host,
      device,
      inventory: null,
      control: null,
      sharedHost: false,
    });
  }
  return rows;
}
