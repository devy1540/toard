"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { ToolCatalogItem } from "@toard/core";
import { FormField } from "@/components/forms/form-field";
import { LibraryNotice } from "@/components/library/library-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  type LibraryModerationState,
  moderateToolCatalogAction,
} from "./library-actions";

const INITIAL_LIBRARY_MODERATION_STATE: LibraryModerationState = {};

export type AdminToolItem = Omit<ToolCatalogItem, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export function LibraryPanel({ workspaceItems, publicItems }: { workspaceItems: AdminToolItem[]; publicItems: AdminToolItem[] }) {
  const t = useTranslations("admin");
  const libraryT = useTranslations("library");
  return (
    <div className="min-w-0 space-y-4">
      <LibraryNotice title={t("library.immediateNotice")} description={t("library.description")} />

      <Card className="min-w-0">
        <CardHeader><CardTitle>{t("library.workspaceTitle", { count: workspaceItems.length })}</CardTitle><CardDescription>{t("library.workspaceDescription")}</CardDescription></CardHeader>
        <CardContent className="min-w-0 space-y-3">
          {workspaceItems.length === 0 ? <p className="text-muted-foreground text-sm">{t("library.empty")}</p> : workspaceItems.map((item) => <ModerationRow key={item.id} item={item} />)}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader><CardTitle>{t("library.publicTitle", { count: publicItems.length })}</CardTitle><CardDescription>{t("library.publicDescription")}</CardDescription></CardHeader>
        <CardContent className="min-w-0 divide-y rounded-md border">
          {publicItems.map((item) => (
            <div key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 md:grid-cols-[minmax(0,1fr)_7rem_8rem_auto]">
              <div className="min-w-0"><p className="truncate font-medium">{item.name}</p><a className="text-muted-foreground block truncate text-xs hover:underline" href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceUrl}</a></div>
              <Badge variant="outline" className="hidden md:inline-flex">{libraryT(`kind.${item.kind}`)}</Badge>
              <code className="hidden truncate text-xs md:block">{item.sourceRef}</code>
              <Badge variant="secondary">{t("library.readOnly")}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ModerationRow({ item }: { item: AdminToolItem }) {
  const t = useTranslations("admin");
  const libraryT = useTranslations("library");
  const [state, action, pending] = useActionState(moderateToolCatalogAction, INITIAL_LIBRARY_MODERATION_STATE);
  return (
    <form action={action} className="min-w-0 space-y-3 rounded-lg border p-3">
      <input type="hidden" name="id" value={item.id} />
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-medium">{item.name}</p><Badge variant="outline">{libraryT(`kind.${item.kind}`)}</Badge><Badge variant={item.trustStatus === "verified" ? "default" : "outline"}>{libraryT(`trust.${item.trustStatus}`)}</Badge></div><p className="text-muted-foreground mt-1 truncate text-xs">{item.ownerName ?? "—"} · {item.sourceUrl}</p></div>
        <p className="text-muted-foreground shrink-0 text-xs" suppressHydrationWarning>{new Date(item.updatedAt).toLocaleDateString()}</p>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-[auto_12rem_minmax(12rem,1fr)_auto] md:items-end">
        <Field orientation="horizontal" className="h-9 w-auto gap-2">
          <Checkbox id={`verified-${item.id}`} name="verified" defaultChecked={item.trustStatus === "verified"} />
          <FieldLabel htmlFor={`verified-${item.id}`} className="font-normal">{t("library.verified")}</FieldLabel>
        </Field>
        <FormField htmlFor={`lifecycle-${item.id}`} label={t("library.lifecycle")}>
          <NativeSelect id={`lifecycle-${item.id}`} name="lifecycleStatus" defaultValue={item.lifecycleStatus}>
            <NativeSelectOption value="published">{libraryT("lifecycle.published")}</NativeSelectOption>
            <NativeSelectOption value="deprecated">{libraryT("lifecycle.deprecated")}</NativeSelectOption>
            <NativeSelectOption value="blocked">{libraryT("lifecycle.blocked")}</NativeSelectOption>
            <NativeSelectOption value="archived">{libraryT("lifecycle.archived")}</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField htmlFor={`reason-${item.id}`} label={t("library.reason")}>
          <Input id={`reason-${item.id}`} name="statusReason" defaultValue={item.statusReason ?? ""} placeholder={t("library.reasonPlaceholder")} />
        </FormField>
        <Button type="submit" size="sm" disabled={pending}>{pending ? t("library.saving") : t("library.save")}</Button>
      </div>
      {state.error ? <p className="text-destructive text-xs">{t(`library.errors.${state.error}`)}</p> : null}
      {state.ok ? <p className="text-emerald-600 text-xs">{t("library.saved")}</p> : null}
    </form>
  );
}
