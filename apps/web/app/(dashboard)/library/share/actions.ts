"use server";

import { redirect } from "next/navigation";
import { parseToolCatalogSubmission, type CatalogFieldErrors } from "@toard/core";
import { createToolCatalogItem, updateToolCatalogItem } from "@/lib/tool-catalog";
import { submissionFromFormData } from "@/lib/tool-catalog-form";
import { getDashboardViewer } from "@/lib/session-user";

export type ShareToolState = {
  fieldErrors?: CatalogFieldErrors;
  formError?: "unauthorized" | "duplicate" | "forbidden" | "save-failed";
};

export async function createToolCatalogAction(
  _previous: ShareToolState,
  formData: FormData,
): Promise<ShareToolState> {
  const viewer = await getDashboardViewer();
  if (!viewer) return { formError: "unauthorized" };
  const parsed = parseToolCatalogSubmission(submissionFromFormData(formData));
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  let created: Awaited<ReturnType<typeof createToolCatalogItem>>;
  try {
    created = await createToolCatalogItem(viewer.id, parsed.value);
  } catch {
    return { formError: "save-failed" };
  }
  if (!created.ok) {
    return created.reason === "slug-conflict"
      ? { fieldErrors: { slug: "invalid" }, formError: "duplicate" }
      : { formError: "save-failed" };
  }
  redirect(`/library/${created.slug}`);
}

export async function updateToolCatalogAction(
  id: string,
  _previous: ShareToolState,
  formData: FormData,
): Promise<ShareToolState> {
  const viewer = await getDashboardViewer();
  if (!viewer) return { formError: "unauthorized" };
  const parsed = parseToolCatalogSubmission(submissionFromFormData(formData));
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  let updated: Awaited<ReturnType<typeof updateToolCatalogItem>>;
  try {
    updated = await updateToolCatalogItem(viewer.id, id, parsed.value);
  } catch {
    return { formError: "save-failed" };
  }
  if (!updated.ok) {
    if (updated.reason === "slug-conflict") return { fieldErrors: { slug: "invalid" }, formError: "duplicate" };
    return { formError: "forbidden" };
  }
  redirect(`/library/${updated.slug}`);
}
