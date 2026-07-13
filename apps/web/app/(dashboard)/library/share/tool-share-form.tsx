"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { ToolCatalogSubmission } from "@toard/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createToolCatalogAction,
  type ShareToolState,
  updateToolCatalogAction,
} from "./actions";

const INITIAL_SHARE_TOOL_STATE: ShareToolState = {};

const EMPTY: ToolCatalogSubmission = {
  name: "",
  slug: "",
  description: "",
  kind: "skill",
  sourceUrl: "",
  sourceRef: "",
  supportedClients: ["codex"],
  requiredEnv: [],
  networkHosts: [],
  installNotes: "",
  uninstallNotes: "",
  inventoryItemKey: "",
  inventorySourceProvider: "codex",
};

export function ToolShareForm({
  mode,
  initial = EMPTY,
  itemId,
}: {
  mode: "create" | "edit";
  initial?: ToolCatalogSubmission;
  itemId?: string;
}) {
  const t = useTranslations("library");
  const action = mode === "edit" && itemId
    ? updateToolCatalogAction.bind(null, itemId)
    : createToolCatalogAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_SHARE_TOOL_STATE);
  const error = (field: keyof ToolCatalogSubmission) =>
    state.fieldErrors?.[field] ? <p className="text-destructive mt-1 text-xs">{t("form.invalidField")}</p> : null;

  return (
    <form action={formAction} className="min-w-0 space-y-6">
      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 text-sm">
        <p className="font-medium">{mode === "edit" ? t("form.editNoticeTitle") : t("form.publishNoticeTitle")}</p>
        <p className="text-muted-foreground mt-1">{mode === "edit" ? t("form.editNotice") : t("form.publishNotice")}</p>
      </div>

      <section className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <FormField htmlFor="name" label={t("form.name")} error={error("name")}><Input id="name" name="name" defaultValue={initial.name} required maxLength={100} /></FormField>
        <FormField htmlFor="slug" label={t("form.slug")} help={t("form.slugHelp")} error={error("slug")}><Input id="slug" name="slug" defaultValue={initial.slug} required maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></FormField>
        <FormField htmlFor="description" className="sm:col-span-2" label={t("form.descriptionLabel")} error={error("description")}><textarea id="description" name="description" defaultValue={initial.description} required maxLength={500} rows={3} className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm" /></FormField>
        <FormField htmlFor="kind" label={t("form.kind")} error={error("kind")}>
          <select id="kind" name="kind" defaultValue={initial.kind} className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"><option value="mcp">{t("kind.mcp")}</option><option value="skill">{t("kind.skill")}</option><option value="plugin">{t("kind.plugin")}</option></select>
        </FormField>
        <FormField label={t("form.clients")} error={error("supportedClients")}>
          <div className="flex h-9 items-center gap-4">
            <Check name="supportedClients" value="codex" label="Codex" checked={initial.supportedClients.includes("codex")} />
            <Check name="supportedClients" value="claude_code" label="Claude Code" checked={initial.supportedClients.includes("claude_code")} />
          </div>
        </FormField>
      </section>

      <section className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <FormField htmlFor="sourceUrl" className="sm:col-span-2" label={t("form.sourceUrl")} help={t("form.sourceUrlHelp")} error={error("sourceUrl")}><Input id="sourceUrl" name="sourceUrl" type="url" defaultValue={initial.sourceUrl} required placeholder="https://github.com/owner/repository" /></FormField>
        <FormField htmlFor="sourceRef" label={t("form.sourceRef")} help={t("form.sourceRefHelp")} error={error("sourceRef")}><Input id="sourceRef" name="sourceRef" defaultValue={initial.sourceRef} required placeholder="v1.2.3" /></FormField>
        <FormField htmlFor="inventorySourceProvider" label={t("form.inventorySourceProvider")} error={error("inventorySourceProvider")}>
          <select id="inventorySourceProvider" name="inventorySourceProvider" defaultValue={initial.inventorySourceProvider} className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"><option value="codex">Codex</option><option value="claude_code">Claude Code</option></select>
        </FormField>
        <FormField htmlFor="inventoryItemKey" className="sm:col-span-2" label={t("form.inventoryItemKey")} help={t("form.inventoryItemKeyHelp")} error={error("inventoryItemKey")}><Input id="inventoryItemKey" name="inventoryItemKey" defaultValue={initial.inventoryItemKey} required maxLength={200} /></FormField>
      </section>

      <section className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <FormField htmlFor="requiredEnv" label={t("form.requiredEnv")} help={t("form.linesHelp")} error={error("requiredEnv")}><textarea id="requiredEnv" name="requiredEnv" defaultValue={initial.requiredEnv.join("\n")} rows={5} placeholder="GITHUB_TOKEN" className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm" /></FormField>
        <FormField htmlFor="networkHosts" label={t("form.networkHosts")} help={t("form.linesHelp")} error={error("networkHosts")}><textarea id="networkHosts" name="networkHosts" defaultValue={initial.networkHosts.join("\n")} rows={5} placeholder="api.github.com" className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm" /></FormField>
        <FormField htmlFor="installNotes" label={t("form.installNotes")} error={error("installNotes")}><textarea id="installNotes" name="installNotes" defaultValue={initial.installNotes} rows={7} className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm" /></FormField>
        <FormField htmlFor="uninstallNotes" label={t("form.uninstallNotes")} error={error("uninstallNotes")}><textarea id="uninstallNotes" name="uninstallNotes" defaultValue={initial.uninstallNotes} rows={7} className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm" /></FormField>
      </section>

      {state.formError ? <p className="text-destructive text-sm">{t(`form.errors.${state.formError}`)}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? t("form.saving") : mode === "edit" ? t("form.saveEdit") : t("form.publish")}</Button>
    </form>
  );
}

function FormField({ htmlFor, label, help, error, className, children }: { htmlFor?: string; label: string; help?: string; error?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <div className={className}><Label htmlFor={htmlFor} className="mb-1.5 block">{label}</Label>{children}{help ? <p className="text-muted-foreground mt-1 text-xs">{help}</p> : null}{error}</div>;
}

function Check({ name, value, label, checked }: { name: string; value: string; label: string; checked: boolean }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={name} value={value} defaultChecked={checked} className="size-4" />{label}</label>;
}
