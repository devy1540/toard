import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateDownloadUrl, type GitHubAppClient } from "./github-app-source";

test("GitHub installation token은 callback 안에서만 쓰고 반환 URL에 포함하지 않는다", async () => {
  const seen: string[] = [];
  const client: GitHubAppClient = {
    async issueInstallationToken(installationId) {
      assert.equal(installationId, 7);
      return "secret-installation-token";
    },
    async requestArchiveUrl(input, token) {
      seen.push(token);
      assert.equal(input.owner, "acme");
      return "https://codeload.github.com/acme/private/tar.gz/aaaaaaaa";
    },
  };

  const url = await createPrivateDownloadUrl(
    { installationId: 7, owner: "acme", repo: "private", exactRef: "a".repeat(40) },
    client,
  );

  assert.equal(url, "https://codeload.github.com/acme/private/tar.gz/aaaaaaaa");
  assert.deepEqual(seen, ["secret-installation-token"]);
  assert.equal(url.includes("secret-installation-token"), false);
});

test("private download URL은 HTTPS GitHub provider host만 허용한다", async () => {
  const client: GitHubAppClient = {
    async issueInstallationToken() {
      return "token";
    },
    async requestArchiveUrl() {
      return "https://evil.example/artifact";
    },
  };

  await assert.rejects(
    createPrivateDownloadUrl(
      { installationId: 7, owner: "acme", repo: "private", exactRef: "a".repeat(40) },
      client,
    ),
    /unexpected GitHub archive host/,
  );
});

test("owner, repository, exact commit 형식을 먼저 검증한다", async () => {
  let called = false;
  const client: GitHubAppClient = {
    async issueInstallationToken() {
      called = true;
      return "token";
    },
    async requestArchiveUrl() {
      return "https://codeload.github.com/acme/private/tar.gz/a";
    },
  };

  await assert.rejects(
    createPrivateDownloadUrl(
      { installationId: 7, owner: "../acme", repo: "private", exactRef: "main" },
      client,
    ),
    /invalid GitHub source/,
  );
  assert.equal(called, false);
});
