"use server";

import { getTranslations } from "next-intl/server";
import { hasAdminUser } from "@/lib/setup";

export type SignupState = { error?: string };

/** Stale clients fail closed. Password accounts require a one-time invitation. */
export async function signupAction(_prev: SignupState, _formData: FormData): Promise<SignupState> {
  const t = await getTranslations("auth");
  if (!(await hasAdminUser())) return { error: t("errors.setupRequired") };
  return { error: t("errors.invitationRequired") };
}
