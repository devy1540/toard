const DB_NAME = "toard-content-v1";
const DB_VERSION = 1;
const DEVICE_STORE = "devices";
const ACTIVE_DEVICE_KEY = "active";

export type StoredBrowserDevice = {
  id: typeof ACTIVE_DEVICE_KEY;
  serverDeviceId: string;
  keyPair: CryptoKeyPair;
};

let unlockedUck: Uint8Array<ArrayBuffer> | null = null;

function openVault(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("CONTENT_KEY_VAULT_OPEN_FAILED"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openVault();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, mode);
      const request = fn(tx.objectStore(DEVICE_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("CONTENT_KEY_VAULT_OPERATION_FAILED"));
      tx.onabort = () => reject(new Error("CONTENT_KEY_VAULT_OPERATION_FAILED"));
    });
  } finally {
    db.close();
  }
}

export const contentKeyVault = {
  async saveDevice(serverDeviceId: string, keyPair: CryptoKeyPair): Promise<void> {
    if (keyPair.privateKey.extractable) throw new Error("DEVICE_KEY_EXTRACTABLE");
    await withStore("readwrite", (store) =>
      store.put({ id: ACTIVE_DEVICE_KEY, serverDeviceId, keyPair } satisfies StoredBrowserDevice),
    );
  },

  async loadDevice(): Promise<StoredBrowserDevice | null> {
    const result = await withStore<StoredBrowserDevice | undefined>("readonly", (store) =>
      store.get(ACTIVE_DEVICE_KEY),
    );
    if (!result) return null;
    if (result.keyPair.privateKey.extractable) throw new Error("DEVICE_KEY_EXTRACTABLE");
    return result;
  },

  unlock(uck: Uint8Array): void {
    if (uck.byteLength !== 32) throw new Error("INVALID_UCK");
    this.lock();
    unlockedUck = new Uint8Array(32);
    unlockedUck.set(uck);
  },

  withUnlockedUck<T>(fn: (uck: Uint8Array) => T): T {
    if (!unlockedUck) throw new Error("CONTENT_LOCKED");
    return fn(unlockedUck);
  },

  isUnlocked(): boolean {
    return unlockedUck !== null;
  },

  lock(): void {
    unlockedUck?.fill(0);
    unlockedUck = null;
  },
};
