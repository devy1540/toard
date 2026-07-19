import { managedContentConfigured } from "./managed-content-runtime";

export {
  decryptContent,
  encryptContent,
  legacyContentKeyConfigured,
  loadKek,
  type EncryptedContent,
} from "./legacy-content-crypto";
export {
  canonicalManagedContentAad,
  decryptManagedContent,
  encryptManagedContent,
  type ManagedEncryptedContent,
} from "./managed-content-crypto";

export { managedContentConfigured };

export function contentCollectionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return managedContentConfigured(env);
}

export function contentCollectionDefaultOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!managedContentConfigured(env)) return false;
  const value = env.CONTENT_COLLECTION_DEFAULT?.trim().toLowerCase();
  return value === "on" || value === "1" || value === "true" || value === "yes";
}
