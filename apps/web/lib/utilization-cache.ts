import { revalidateTag } from "next/cache";

export const ORGANIZATION_UTILIZATION_CACHE_TAG = "utilization:organization:v2";
export const ALL_PERSONAL_UTILIZATION_CACHE_TAG = "utilization:personal:v2";

export function personalUtilizationCacheTag(userId: string): string {
  return `utilization:personal:v2:${userId}`;
}

export function utilizationCacheTagsForUser(userId: string): [string, string] {
  return [personalUtilizationCacheTag(userId), ORGANIZATION_UTILIZATION_CACHE_TAG];
}

export function invalidateUtilizationForUser(
  userId: string,
  invalidate: (tag: string) => void = revalidateTag,
): void {
  for (const tag of utilizationCacheTagsForUser(userId)) invalidate(tag);
}

export function invalidateAllUtilization(
  invalidate: (tag: string) => void = revalidateTag,
): void {
  invalidate(ALL_PERSONAL_UTILIZATION_CACHE_TAG);
  invalidate(ORGANIZATION_UTILIZATION_CACHE_TAG);
}
