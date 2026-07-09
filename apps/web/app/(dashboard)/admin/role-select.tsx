"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { UserRole } from "@/lib/admin-members";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignRoleAction } from "./team-actions";

export function RoleSelect({ userId, current }: { userId: string; current: UserRole }) {
  const t = useTranslations("admin");
  const [pending, startTransition] = useTransition();

  const roleLabel = (role: UserRole) =>
    role === "admin" ? t("roleSelect.admin") : t("roleSelect.member");

  const onChange = (value: UserRole) => {
    startTransition(async () => {
      const r = await assignRoleAction(userId, value);
      if (r.error) toast.error(r.error);
      else toast.success(t("roleSelect.updatedToast", { role: roleLabel(value) }));
    });
  };

  return (
    <Select value={current} onValueChange={onChange} disabled={pending}>
      <SelectTrigger
        className="h-8 w-auto justify-start gap-1.5"
        aria-label={t("roleSelect.label")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">{t("roleSelect.member")}</SelectItem>
        <SelectItem value="admin">{t("roleSelect.admin")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
