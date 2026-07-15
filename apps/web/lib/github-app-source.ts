export type PrivateGitHubSource = {
  installationId: number;
  owner: string;
  repo: string;
  exactRef: string;
};

export type GitHubAppClient = {
  issueInstallationToken(installationId: number): Promise<string>;
  requestArchiveUrl(input: Omit<PrivateGitHubSource, "installationId">, token: string): Promise<string>;
};

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

function validateSource(input: PrivateGitHubSource): void {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !OWNER_OR_REPO.test(input.owner) ||
    !OWNER_OR_REPO.test(input.repo) ||
    !COMMIT_SHA.test(input.exactRef)
  ) {
    throw new Error("invalid GitHub source");
  }
}

function isGitHubArchiveHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname === "codeload.github.com" ||
    hostname.endsWith(".githubusercontent.com")
  );
}

export async function createPrivateDownloadUrl(
  input: PrivateGitHubSource,
  client: GitHubAppClient,
): Promise<string> {
  validateSource(input);
  const token = await client.issueInstallationToken(input.installationId);
  const urlValue = await client.requestArchiveUrl(
    { owner: input.owner, repo: input.repo, exactRef: input.exactRef },
    token,
  );
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || !isGitHubArchiveHost(url.hostname)) {
    throw new Error("unexpected GitHub archive host");
  }
  return url.toString();
}
