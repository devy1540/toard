import { getRequestOrigin } from "./public-url";
import type { WebAuthnContext } from "./mfa-store";

export async function getWebAuthnContext(): Promise<WebAuthnContext> {
  const origin = await getRequestOrigin();
  const url = new URL(origin);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("PASSKEY_SECURE_CONTEXT_REQUIRED");
  return { origin: url.origin, rpID: url.hostname, rpName: "toard" };
}
