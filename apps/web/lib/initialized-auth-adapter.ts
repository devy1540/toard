import type { Adapter } from "next-auth/adapters";

/** 초기 admin이 생기기 전에는 OAuth adapter가 일반 member를 선생성하지 못하게 한다. */
export function guardAdapterUserCreation(
  adapter: Adapter,
  initialized: () => Promise<boolean>,
): Adapter {
  const createUser = adapter.createUser;
  if (!createUser) return adapter;
  return {
    ...adapter,
    async createUser(user) {
      if (!(await initialized())) throw new Error("INITIAL_SETUP_REQUIRED");
      return createUser.call(adapter, user);
    },
  };
}
