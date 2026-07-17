import { LocalKeyManagementProvider } from "../apps/web/lib/key-management/local-provider";
import { decryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { KeyContext, WrappedUserKey } from "../apps/web/lib/key-management/types";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("CHILD_INPUT_MISSING");
  return value;
}

try {
  const context = JSON.parse(required("CONTEXT")) as KeyContext;
  const rawWrapper = JSON.parse(required("WRAPPED")) as Omit<WrappedUserKey, "ciphertext"> & { ciphertext: string };
  const rawRow = JSON.parse(required("ROW")) as Record<string, unknown>;
  const provider = new LocalKeyManagementProvider({ keyFile: required("KEY_FILE") });
  const uck = await provider.unwrapKey({ ...rawWrapper, ciphertext: Buffer.from(rawWrapper.ciphertext, "base64") }, context);
  try {
    const text = decryptManagedContent({
      encryptionScheme: "managed_v1",
      contentKeyVersion: Number(rawRow.contentKeyVersion),
      aadVersion: 2,
      wrappedDek: Buffer.from(String(rawRow.wrappedDek), "base64"),
      dekWrapIv: Buffer.from(String(rawRow.dekWrapIv), "base64"),
      dekWrapAuthTag: Buffer.from(String(rawRow.dekWrapAuthTag), "base64"),
      iv: Buffer.from(String(rawRow.iv), "base64"),
      ciphertext: Buffer.from(String(rawRow.ciphertext), "base64"),
      authTag: Buffer.from(String(rawRow.authTag), "base64"),
      dedupKey: String(rawRow.dedupKey),
      providerKey: String(rawRow.providerKey),
      turnRole: rawRow.turnRole as "user" | "assistant",
      ts: new Date(String(rawRow.ts)),
    }, uck, context.installationId, context.userId);
    if (text !== required("EXPECTED")) throw new Error("CHILD_PLAINTEXT_MISMATCH");
    process.stdout.write("DECRYPT_OK\n");
  } finally {
    uck.fill(0);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "CHILD_FAILED"}\n`);
  process.exitCode = 1;
}
