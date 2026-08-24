import assert from "node:assert/strict";
import test from "node:test";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import { guardAdapterUserCreation } from "./initialized-auth-adapter";

const user: AdapterUser = {
  id: "user-1",
  email: "user@example.com",
  emailVerified: null,
  name: "User",
  image: null,
};

test("초기 admin 전에는 OAuth adapter user 생성을 차단한다", async () => {
  let createCalls = 0;
  const adapter: Adapter = {
    async createUser(input) {
      createCalls += 1;
      return input;
    },
  };
  const guarded = guardAdapterUserCreation(adapter, async () => false);

  await assert.rejects(async () => guarded.createUser!(user), /INITIAL_SETUP_REQUIRED/);
  assert.equal(createCalls, 0);
});

test("초기 admin 뒤에는 기존 OAuth adapter 동작을 보존한다", async () => {
  let createCalls = 0;
  const adapter: Adapter = {
    async createUser(input) {
      createCalls += 1;
      return input;
    },
  };
  const guarded = guardAdapterUserCreation(adapter, async () => true);

  assert.deepEqual(await guarded.createUser!(user), user);
  assert.equal(createCalls, 1);
});
