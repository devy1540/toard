import GitHub, {
  type GitHubEmail,
  type GitHubProfile,
} from "next-auth/providers/github";

type GitHubConfig = Parameters<typeof GitHub>[0];
type Fetcher = typeof fetch;

export type VerifiedGitHubProfile = GitHubProfile & { email_verified: boolean };

export function selectVerifiedPrimaryGitHubEmail(emails: GitHubEmail[]): GitHubEmail | null {
  return emails.find((email) => email.primary && email.verified) ?? null;
}

export async function requestVerifiedGitHubProfile(
  accessToken: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<VerifiedGitHubProfile> {
  if (!accessToken) throw new Error("GITHUB_ACCESS_TOKEN_MISSING");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "authjs",
  };
  const [profileResponse, emailsResponse] = await Promise.all([
    fetcher("https://api.github.com/user", { headers }),
    fetcher("https://api.github.com/user/emails", { headers }),
  ]);
  if (!profileResponse.ok || !emailsResponse.ok) {
    throw new Error("GITHUB_VERIFIED_PROFILE_UNAVAILABLE");
  }
  const profile = await profileResponse.json() as GitHubProfile;
  const emails = await emailsResponse.json() as GitHubEmail[];
  const primary = selectVerifiedPrimaryGitHubEmail(emails);
  return {
    ...profile,
    email: primary?.email ?? null,
    email_verified: primary !== null,
  };
}

/** same-email 자동 연결은 verified primary email과 명시적 bootstrap 창에서만 사용한다. */
export function createVerifiedGitHubProvider(
  config: GitHubConfig,
  fetcher: Fetcher = fetch,
) {
  return GitHub({
    ...config,
    userinfo: {
      url: "https://api.github.com/user",
      request: ({ tokens }: { tokens: { access_token?: string } }) =>
        requestVerifiedGitHubProfile(tokens.access_token, fetcher),
    },
  });
}
