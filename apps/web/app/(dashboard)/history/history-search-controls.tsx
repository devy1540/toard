"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { submitHistorySearch } from "./history-search-actions";

const QUERY_LIMIT = 200;

export function HistorySearchControls({ initialQuery }: { initialQuery: string }) {
  const t = useTranslations("dashboard.history");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawAgent = searchParams.get("agent");
  const agent = rawAgent === "main" || rawAgent === "subagent"
    ? rawAgent
    : "all";
  const agentLabel = agent === "main"
    ? t("agentFilterMain")
    : agent === "subagent"
      ? t("agentFilterSubagent")
      : t("agentFilterAll");
  const [draft, setDraft] = useState(initialQuery.slice(0, QUERY_LIMIT));

  useEffect(() => setDraft(initialQuery.slice(0, QUERY_LIMIT)), [initialQuery]);

  const push = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("page");
    next.delete("session");
    next.delete("cursor");
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const encoded = next.toString();
    router.push(encoded ? `${pathname}?${encoded}` : pathname);
  };

  const clear = () => {
    setDraft("");
    push({ search: null, q: null });
  };

  return (
    <>
      <form className="flex min-w-0 items-center gap-1" role="search" action={submitHistorySearch}>
        <input type="hidden" name="params" value={searchParams.toString()} />
        <div className="relative min-w-0">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            inputMode="search"
            name="query"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, QUERY_LIMIT))}
            maxLength={QUERY_LIMIT}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")}
            className="h-8 w-52 pr-8 pl-8 sm:w-64"
          />
          {draft ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clear}
              aria-label={t("searchClear")}
              className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <Button type="submit" size="sm" variant="outline">
          {t("searchSubmit")}
        </Button>
      </form>

      <Select value={agent} onValueChange={(value) => push({ agent: value === "all" ? null : value })}>
        <SelectTrigger className="h-8 min-w-32 justify-start gap-1.5" aria-label={t("agentFilterLabel")}>
          <span className="min-w-0 flex-1 truncate text-left">{agentLabel}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("agentFilterAll")}</SelectItem>
          <SelectItem value="main">{t("agentFilterMain")}</SelectItem>
          <SelectItem value="subagent">{t("agentFilterSubagent")}</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}
