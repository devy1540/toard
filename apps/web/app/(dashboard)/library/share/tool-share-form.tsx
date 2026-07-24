"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import type { ToolCatalogSubmission } from "@toard/core";
import { FormField } from "@/components/forms/form-field";
import { LibraryNotice } from "@/components/library/library-notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
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
  detectedTools = [],
}: {
  mode: "create" | "edit";
  initial?: ToolCatalogSubmission;
  itemId?: string;
  detectedTools?: Array<{ kind: "mcp" | "skill" | "plugin"; itemKey: string; displayName: string; sourceProvider: string }>;
}) {
  const t = useTranslations("library");
  const action = mode === "edit" && itemId
    ? updateToolCatalogAction.bind(null, itemId)
    : createToolCatalogAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_SHARE_TOOL_STATE);
  const [sourceMode, setSourceMode] = useState<"device" | "github">("github");
  const error = (field: keyof ToolCatalogSubmission) =>
    state.fieldErrors?.[field] ? t("form.invalidField") : undefined;

  return (
    <form action={formAction} className="min-w-0 space-y-6">
      <LibraryNotice
        title={mode === "edit" ? t("form.editNoticeTitle") : t("form.publishNoticeTitle")}
        description={mode === "edit" ? t("form.editNotice") : t("form.publishNotice")}
      />

      {mode === "create" ? (
        <section className="space-y-3" aria-labelledby="share-source-heading">
          <div>
            <h2 id="share-source-heading" className="font-medium">{t("form.startTitle")}</h2>
            <p className="text-muted-foreground mt-1 text-sm">{t("form.startDescription")}</p>
          </div>
          <RadioGroup
            name="shareSourceMode"
            value={sourceMode}
            onValueChange={(value) => setSourceMode(value as "device" | "github")}
            className="grid gap-3 sm:grid-cols-2"
          >
            <FieldLabel
              htmlFor="share-source-device"
              className="has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 w-full cursor-pointer rounded-lg"
            >
              <Field orientation="horizontal" className="items-start">
                <FieldContent>
                  <FieldTitle>{t("form.fromDevice")}</FieldTitle>
                  <span className="text-muted-foreground text-xs">{t("form.fromDeviceDescription")}</span>
                </FieldContent>
                <RadioGroupItem id="share-source-device" value="device" className="mt-0.5" />
              </Field>
            </FieldLabel>
            <FieldLabel
              htmlFor="share-source-github"
              className="has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 w-full cursor-pointer rounded-lg"
            >
              <Field orientation="horizontal" className="items-start">
                <FieldContent>
                  <FieldTitle>{t("form.fromGithub")}</FieldTitle>
                  <span className="text-muted-foreground text-xs">{t("form.fromGithubDescription")}</span>
                </FieldContent>
                <RadioGroupItem id="share-source-github" value="github" className="mt-0.5" />
              </Field>
            </FieldLabel>
          </RadioGroup>
          {sourceMode === "device" ? (
            <div className="rounded-lg border bg-card p-4">
              <FormField
                htmlFor="detectedTool"
                label={t("form.detectedTool")}
                description={t("form.deviceImportNotice")}
              >
                <NativeSelect
                  id="detectedTool"
                  defaultValue=""
                  onChange={(event) => {
                    const tool = detectedTools[Number(event.currentTarget.value)];
                    const form = event.currentTarget.form;
                    if (!tool || !form) return;
                    const set = (name: string, value: string) => {
                      const field = form.elements.namedItem(name);
                      if (
                        field instanceof HTMLInputElement
                        || field instanceof HTMLSelectElement
                        || field instanceof HTMLTextAreaElement
                      ) {
                        field.value = value;
                      }
                    };
                    set("name", tool.displayName);
                    set("slug", tool.itemKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                    set("kind", tool.kind);
                    set("inventoryItemKey", tool.itemKey);
                    set("inventorySourceProvider", tool.sourceProvider === "claude_code" ? "claude_code" : "codex");
                  }}
                >
                  <NativeSelectOption value="">
                    {detectedTools.length ? t("form.detectedToolPlaceholder") : t("form.noDetectedTools")}
                  </NativeSelectOption>
                  {detectedTools.map((tool, index) => (
                    <NativeSelectOption key={`${tool.kind}:${tool.sourceProvider}:${tool.itemKey}`} value={index}>
                      {tool.displayName} · {tool.sourceProvider}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <FormField htmlFor="name" label={t("form.name")} error={error("name")}><Input id="name" name="name" defaultValue={initial.name} required maxLength={100} /></FormField>
        <FormField htmlFor="slug" label={t("form.slug")} description={t("form.slugHelp")} error={error("slug")}><Input id="slug" name="slug" defaultValue={initial.slug} required maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></FormField>
        <FormField htmlFor="description" className="sm:col-span-2" label={t("form.descriptionLabel")} error={error("description")}><Textarea id="description" name="description" defaultValue={initial.description} required maxLength={500} rows={3} /></FormField>
        <FormField htmlFor="kind" label={t("form.kind")} error={error("kind")}>
          <NativeSelect id="kind" name="kind" defaultValue={initial.kind}>
            <NativeSelectOption value="mcp">{t("kind.mcp")}</NativeSelectOption>
            <NativeSelectOption value="skill">{t("kind.skill")}</NativeSelectOption>
            <NativeSelectOption value="plugin">{t("kind.plugin")}</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField label={t("form.clients")} error={error("supportedClients")}>
          <div className="flex h-9 items-center gap-4">
            <Check name="supportedClients" value="codex" label="Codex" checked={initial.supportedClients.includes("codex")} />
            <Check name="supportedClients" value="claude_code" label="Claude Code" checked={initial.supportedClients.includes("claude_code")} />
          </div>
        </FormField>
      </section>

      <section className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <FormField htmlFor="sourceUrl" className="sm:col-span-2" label={t("form.sourceUrl")} description={t("form.sourceUrlHelp")} error={error("sourceUrl")}><Input id="sourceUrl" name="sourceUrl" type="url" defaultValue={initial.sourceUrl} required placeholder="https://github.com/owner/repository" /></FormField>
        <FormField htmlFor="sourceRef" label={t("form.sourceRef")} description={t("form.sourceRefHelp")} error={error("sourceRef")}><Input id="sourceRef" name="sourceRef" defaultValue={initial.sourceRef} required placeholder="v1.2.3" /></FormField>
        <FormField htmlFor="inventorySourceProvider" label={t("form.inventorySourceProvider")} error={error("inventorySourceProvider")}>
          <NativeSelect id="inventorySourceProvider" name="inventorySourceProvider" defaultValue={initial.inventorySourceProvider}>
            <NativeSelectOption value="codex">Codex</NativeSelectOption>
            <NativeSelectOption value="claude_code">Claude Code</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField htmlFor="inventoryItemKey" className="sm:col-span-2" label={t("form.inventoryItemKey")} description={t("form.inventoryItemKeyHelp")} error={error("inventoryItemKey")}><Input id="inventoryItemKey" name="inventoryItemKey" defaultValue={initial.inventoryItemKey} required maxLength={200} /></FormField>
      </section>

      <Disclosure
        defaultOpen={mode === "edit"}
        forceMount
        className="rounded-lg border bg-card"
        trigger={t("form.advanced")}
        triggerClassName="w-full justify-between px-4 py-3 text-left font-medium"
        contentClassName="border-t"
      >
        <section className="grid min-w-0 gap-4 p-4 sm:grid-cols-2">
          <FormField htmlFor="requiredEnv" label={t("form.requiredEnv")} description={t("form.linesHelp")} error={error("requiredEnv")}><Textarea id="requiredEnv" name="requiredEnv" defaultValue={initial.requiredEnv.join("\n")} rows={5} placeholder="GITHUB_TOKEN" className="font-mono" /></FormField>
          <FormField htmlFor="networkHosts" label={t("form.networkHosts")} description={t("form.linesHelp")} error={error("networkHosts")}><Textarea id="networkHosts" name="networkHosts" defaultValue={initial.networkHosts.join("\n")} rows={5} placeholder="api.github.com" className="font-mono" /></FormField>
          <FormField htmlFor="installNotes" label={t("form.installNotes")} error={error("installNotes")}><Textarea id="installNotes" name="installNotes" defaultValue={initial.installNotes} rows={7} className="font-mono" /></FormField>
          <FormField htmlFor="uninstallNotes" label={t("form.uninstallNotes")} error={error("uninstallNotes")}><Textarea id="uninstallNotes" name="uninstallNotes" defaultValue={initial.uninstallNotes} rows={7} className="font-mono" /></FormField>
        </section>
      </Disclosure>

      {state.formError ? <FieldError>{t(`form.errors.${state.formError}`)}</FieldError> : null}
      <Button type="submit" disabled={pending}>{pending ? t("form.saving") : mode === "edit" ? t("form.saveEdit") : t("form.publish")}</Button>
    </form>
  );
}

function Check({ name, value, label, checked }: { name: string; value: string; label: string; checked: boolean }) {
  const id = `${name}-${value}`;
  return (
    <Field orientation="horizontal" className="w-auto gap-2">
      <Checkbox id={id} name={name} value={value} defaultChecked={checked} />
      <FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel>
    </Field>
  );
}
