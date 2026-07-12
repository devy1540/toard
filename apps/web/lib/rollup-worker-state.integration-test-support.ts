import type { PoolConfig } from "pg";

const ISOLATED_DATABASE_ERROR =
  "integration test requires a localhost database whose name ends with _test";

export function createIsolatedPostgresPoolConfig(databaseUrl: string): PoolConfig {
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port ? Number(url.port) : 5432;
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      !database.endsWith("_test") ||
      database.includes("\0") ||
      port < 1 ||
      url.searchParams.has("host")
    ) {
      throw new Error(ISOLATED_DATABASE_ERROR);
    }

    return {
      host: url.hostname,
      port,
      database,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    throw new Error(ISOLATED_DATABASE_ERROR);
  }
}
