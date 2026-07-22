"use server";

import { redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/current-user";
import {
  encodeHistorySearchQueryToken,
  sanitizeHistorySearchQuery,
} from "@/lib/history-search-token";

const PRESERVED_FILTERS = ["period", "provider", "from", "to", "source", "agent"] as const;
const PARAMS_LIMIT = 2_048;

function formValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function submitHistorySearch(formData: FormData): Promise<never> {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/history");
  const rawParams = formValue(formData, "params").slice(0, PARAMS_LIMIT);
  const current = new URLSearchParams(rawParams);
  const next = new URLSearchParams();
  for (const key of PRESERVED_FILTERS) {
    const value = current.get(key);
    if (value && value.length <= 255) next.set(key, value);
  }

  const query = sanitizeHistorySearchQuery(formValue(formData, "query"));
  if (query) {
    next.set(
      "search",
      encodeHistorySearchQueryToken(query, process.env.AUTH_SECRET ?? "", userId),
    );
  }
  const encoded = next.toString();
  redirect(encoded ? `/history?${encoded}` : "/history");
}
