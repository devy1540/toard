import { createHash } from "node:crypto";
import { LocalKeyManagementProvider } from "../apps/web/lib/key-management/local-provider";
import { decryptManagedContent } from "../apps/web/lib/managed-content-crypto";
import type { KeyContext, WrappedUserKey } from "../apps/web/lib/key-management/types";

const LOCAL_KEK_FILE = "/run/toard-secrets/local-kek";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("CHILD_INPUT_MISSING");
  return value;
}

try {
  const context = JSON.parse(required("CONTEXT")) as KeyContext;
  const rawWrapper = JSON.parse(required("WRAPPED")) as Omit<WrappedUserKey, "ciphertext" | "keyRef"> & { ciphertext: string };
  const rawRow = JSON.parse(required("ROW")) as Record<string, unknown>;
  const provider = new LocalKeyManagementProvider({ keyFile: LOCAL_KEK_FILE });
  const uck = await provider.unwrapKey({
    ...rawWrapper,
    keyRef: `file:${LOCAL_KEK_FILE}`,
    ciphertext: Buffer.from(rawWrapper.ciphertext, "base64"),
  }, context);
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
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    process.stdout.write(`PLAINTEXT_SHA256:${digest}\n`);
  } finally {
    uck.fill(0);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "CHILD_FAILED"}\n`);
  process.exitCode = 1;
}
