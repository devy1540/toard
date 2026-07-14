import { fromLiteLLM, type PricingMap } from "@toard/pricing";

const COMMITS_URL = "https://api.github.com/repos/BerriAI/litellm/commits";
const RAW_BASE_URL = "https://raw.githubusercontent.com/BerriAI/litellm";
const PRICING_PATH = "model_prices_and_context_window.json";
const REQUEST_TIMEOUT_MS = 10_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type GitHubCommitResponse = {
  sha?: unknown;
  commit?: { committer?: { date?: unknown } };
};

export type PricingHistoryCommitRef = {
  sha: string;
  committedAt: string;
};

export class PricingSourceRateLimitError extends Error {
  constructor(public readonly resetAt: Date) {
    super("pricing source rate limited");
    this.name = "PricingSourceRateLimitError";
  }
}

function rateLimitReset(response: Response, now: Date): Date | null {
  const limited = response.status === 403 || response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0";
  if (!limited) return null;

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(now.getTime() + retryAfter * 1_000);
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetSeconds = resetHeader == null ? Number.NaN : Number(resetHeader);
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return new Date(resetSeconds * 1_000);
  }
  return new Date(now.getTime() + 60_000);
}

function parseCommitRefs(value: unknown): PricingHistoryCommitRef[] {
  if (!Array.isArray(value)) throw new Error("invalid pricing commit response");
  return value.map((raw) => {
    const item = raw as GitHubCommitResponse;
    const sha = item.sha;
    const date = item.commit?.committer?.date;
    const committedAt = typeof date === "string" ? new Date(date) : new Date(Number.NaN);
    if (typeof sha !== "string" || !SHA_PATTERN.test(sha) || !Number.isFinite(committedAt.getTime())) {
      throw new Error("invalid pricing commit response");
    }
    return { sha: sha.toLowerCase(), committedAt: committedAt.toISOString() };
  });
}

export class GitHubPricingHistorySource {
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly token = process.env.GITHUB_TOKEN?.trim(),
  ) {}

  private async list(url: URL): Promise<PricingHistoryCommitRef[]> {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const resetAt = rateLimitReset(response, this.now());
    if (resetAt) throw new PricingSourceRateLimitError(resetAt);
    if (!response.ok) throw new Error(`pricing commit list failed: ${response.status}`);
    return parseCommitRefs(await response.json());
  }

  async listBaseline(until: Date): Promise<PricingHistoryCommitRef[]> {
    const url = new URL(COMMITS_URL);
    url.searchParams.set("path", PRICING_PATH);
    url.searchParams.set("until", until.toISOString());
    url.searchParams.set("per_page", "1");
    url.searchParams.set("page", "1");
    return this.list(url);
  }

  async listChanges(from: Date, to: Date, page: number): Promise<PricingHistoryCommitRef[]> {
    if (!Number.isInteger(page) || page < 1) throw new Error("invalid pricing history page");
    const url = new URL(COMMITS_URL);
    url.searchParams.set("path", PRICING_PATH);
    url.searchParams.set("since", from.toISOString());
    url.searchParams.set("until", to.toISOString());
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    return this.list(url);
  }

  async fetchSnapshot(sha: string): Promise<PricingMap> {
    if (!SHA_PATTERN.test(sha)) throw new Error("invalid pricing source sha");
    const response = await this.fetcher(`${RAW_BASE_URL}/${sha}/${PRICING_PATH}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`pricing snapshot fetch failed: ${response.status}`);
    const raw = await response.json() as Parameters<typeof fromLiteLLM>[0];
    const pricing = fromLiteLLM(raw);
    if (pricing.size === 0) throw new Error("pricing snapshot parsed 0 models");
    return pricing;
  }
}
