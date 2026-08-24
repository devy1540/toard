import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("초기 admin 전에는 login, signup, dashboard가 setup으로 수렴한다", () => {
  const login = source("app/login/page.tsx");
  const signupPage = source("app/signup/page.tsx");
  const signupAction = source("app/signup/actions.ts");
  const dashboard = source("app/(dashboard)/layout.tsx");

  for (const text of [login, signupPage, signupAction, dashboard]) {
    assert.match(text, /hasAdminUser/);
  }
  assert.match(signupPage, /redirect\("\/setup"\)/);
  assert.match(signupAction, /errors\.setupRequired/);
  assert.match(dashboard, /if \(!initialized\) redirect\("\/setup"\)/);
});

test("browser setup은 token 입력과 adapter createUser guard를 함께 사용한다", () => {
  const form = source("app/setup/setup-form.tsx");
  const action = source("app/setup/actions.ts");
  const auth = source("auth.ts");

  assert.match(form, /name="setupToken"/);
  assert.match(form, /minLength=\{32\}/);
  assert.match(form, /credentialsEnabled \?/);
  assert.match(action, /verifyBootstrapSetupToken\(setupToken\)/);
  assert.match(action, /if \(!credentialsEnabled\) redirect\("\/login"\)/);
  assert.match(auth, /createVerifiedGitHubProvider/);
  assert.match(auth, /adminOAuthLinkingEnabled = !credentialsEnabled/);
  assert.match(auth, /guardAdapterUserCreation\([\s\S]*adminOAuthLinkingEnabled/);
  assert.match(auth, /email_verified !== true/);
});
