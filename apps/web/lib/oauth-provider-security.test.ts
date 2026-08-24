import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerifiedGitHubProvider,
  requestVerifiedGitHubProfile,
  selectVerifiedPrimaryGitHubEmail,
} from "./oauth-provider-security";

const profile = {
  login: "admin",
  id: 1,
  avatar_url: "https://example.com/avatar.png",
  name: "Admin",
  email: "public@example.com",
};

test("GitHub linking은 verified primary email만 신뢰한다", () => {
  assert.equal(selectVerifiedPrimaryGitHubEmail([
    { email: "primary@example.com", primary: true, verified: false, visibility: "private" },
    { email: "other@example.com", primary: false, verified: true, visibility: "private" },
  ]), null);
  assert.equal(selectVerifiedPrimaryGitHubEmail([
    { email: "primary@example.com", primary: true, verified: true, visibility: "private" },
  ])?.email, "primary@example.com");
});

test("GitHub raw profile은 verified primary email과 검증 상태를 함께 반환한다", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    return Response.json(url.endsWith("/emails")
      ? [{ email: "verified@example.com", primary: true, verified: true, visibility: "private" }]
      : profile);
  };
  const result = await requestVerifiedGitHubProfile("token", fetcher);

  assert.equal(result.email, "verified@example.com");
  assert.equal(result.email_verified, true);
});

test("verified primary email이 없으면 GitHub profile을 linking 불가로 닫는다", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    return Response.json(url.endsWith("/emails") ? [] : profile);
  };
  const result = await requestVerifiedGitHubProfile("token", fetcher);

  assert.equal(result.email, null);
  assert.equal(result.email_verified, false);
});

test("GitHub provider는 bootstrap 창에서만 same-email linking 옵션을 받는다", () => {
  const provider = createVerifiedGitHubProvider({ allowDangerousEmailAccountLinking: true });
  assert.equal(provider.options?.allowDangerousEmailAccountLinking, true);
  assert.equal(
    typeof (provider.options as { userinfo?: { request?: unknown } } | undefined)?.userinfo?.request,
    "function",
  );
});
