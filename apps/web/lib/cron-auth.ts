import { timingSafeEqual } from "node:crypto";

function matchesBearerSecret(authorization: string | null, secret: string): boolean {
  if (!authorization) return false;
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** mutation cron은 secret 미설정 상태에서도 절대 실행하지 않는다. */
export function requireCronAuthorization(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("cron unavailable", { status: 503 });
  if (!matchesBearerSecret(req.headers.get("authorization"), secret)) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}
