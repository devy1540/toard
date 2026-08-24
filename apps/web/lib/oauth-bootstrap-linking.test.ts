import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { guardAdapterUserCreation } from "./initialized-auth-adapter";

type HandleLogin = (
  sessionToken: null,
  profile: AdapterUser,
  account: AdapterAccount,
  options: Record<string, unknown>,
) => Promise<{ user: AdapterUser; isNewUser: boolean }>;

async function loadInstalledAuthJsHandleLogin(): Promise<HandleLogin> {
  const nextAuthEntry = fileURLToPath(import.meta.resolve("next-auth"));
  const modulePath = resolve(
    dirname(nextAuthEntry),
    "../@auth/core/lib/actions/callback/handle-login.js",
  );
  const loaded = await import(pathToFileURL(modulePath).href) as { handleLoginOrRegister: HandleLogin };
  return loaded.handleLoginOrRegister;
}

test("설치된 Auth.js OAuth flow가 bootstrap admin을 same-email account에 연결한다", async () => {
  const admin = {
    id: "admin-1",
    email: "verified@example.com",
    emailVerified: null,
    name: "Admin",
    image: null,
    role: "admin",
  } as AdapterUser & { role: "admin" };
  const linkedAccounts: AdapterAccount[] = [];
  const baseAdapter: Adapter = {
    async createUser() { throw new Error("must not create a second user"); },
    async getUser() { return null; },
    async getUserByAccount() { return null; },
    async getUserByEmail(email) { return email === admin.email ? admin : null; },
    async linkAccount(account) { linkedAccounts.push(account); return account; },
  };
  const adapter = guardAdapterUserCreation(baseAdapter, async () => true, () => true);
  const handleLogin = await loadInstalledAuthJsHandleLogin();
  const account: AdapterAccount = {
    provider: "github",
    providerAccountId: "github-account-1",
    type: "oauth",
    userId: "",
  };

  const result = await handleLogin(null, admin, account, {
    adapter,
    jwt: { decode: async () => null },
    events: {},
    session: { strategy: "jwt", generateSessionToken: () => "unused" },
    cookies: { sessionToken: { name: "authjs.session-token" } },
    provider: {
      id: "github",
      type: "oauth",
      allowDangerousEmailAccountLinking: true,
      account: (tokens: Record<string, unknown>) => tokens,
    },
  });

  assert.equal(result.user.id, admin.id);
  assert.equal(result.isNewUser, false);
  assert.equal(linkedAccounts[0]?.userId, admin.id);
  assert.equal(linkedAccounts[0]?.providerAccountId, "github-account-1");
});
