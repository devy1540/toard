"use server";

import { revalidatePath } from "next/cache";
import { isToolCatalogLifecycle, isToolCatalogTrust } from "@toard/core";
import { moderateToolCatalogItem } from "@/lib/tool-catalog";
import { getSessionUser } from "@/lib/session-user";

export type LibraryModerationState = {
  ok?: boolean;
  error?: "forbidden" | "invalid" | "reasonRequired" | "saveFailed";
};

export async function moderateToolCatalogAction(
  _previous: LibraryModerationState,
  formData: FormData,
): Promise<LibraryModerationState> {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return { error: "forbidden" };

  const id = String(formData.get("id") ?? "");
  const trustStatus = formData.get("verified") === "on" ? "verified" : "community";
  const lifecycleStatus = String(formData.get("lifecycleStatus") ?? "");
  const statusReason = String(formData.get("statusReason") ?? "").trim().slice(0, 500);
  if (!id || !isToolCatalogTrust(trustStatus) || !isToolCatalogLifecycle(lifecycleStatus)) {
    return { error: "invalid" };
  }
  if ((lifecycleStatus === "blocked" || lifecycleStatus === "deprecated") && !statusReason) {
    return { error: "reasonRequired" };
  }

  try {
    const result = await moderateToolCatalogItem(user, id, {
      trustStatus,
      lifecycleStatus,
      statusReason: statusReason || null,
    });
    if (!result.ok) return { error: result.reason === "forbidden" ? "forbidden" : "invalid" };
  } catch {
    return { error: "saveFailed" };
  }

  revalidatePath("/admin");
  revalidatePath("/library");
  return { ok: true };
}
