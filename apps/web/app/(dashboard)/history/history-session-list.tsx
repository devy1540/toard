import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageSquareText } from "lucide-react";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtCompact } from "@/lib/format";
import {
  compactHistoryList,
  historyDayKey,
  historyPagination,
  type HistoryListItem,
} from "./history-list-view";

const MODEL_BADGE_MAX = 2;
const HOST_BADGE_MAX = 1;

export function HistorySessionList({
  items,
  totalSessions,
  page,
  prevHref,
  nextHref,
  locale,
  timezone,
  labels,
  searchMode = false,
}: {
  items: HistoryListItem[];
  totalSessions: number;
  page: number;
  prevHref: string | null;
  nextHref: string | null;
  locale: string;
  timezone: string;
  labels: { total: string; prev: string; next: string; pageInfo: string };
  /** 본문 검색은 전체 개수 대신 서명된 다음 스캔 커서를 사용한다. */
  searchMode?: boolean;
}) {
  const pagination = historyPagination(page, totalSessions);
  const dayFormatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: "medium" });
  const timeFormatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: "short" });
  const timestampFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <>
      <Card className="min-w-0 overflow-hidden py-0">
        <CardContent className="p-0">
          <div className="divide-y">
            {items.map((item, index) => {
              const previous = index > 0 ? items[index - 1] : undefined;
              const showDay = previous === undefined
                || historyDayKey(previous.latestTs, timezone) !== historyDayKey(item.latestTs, timezone);
              const latestTs = new Date(item.latestTs);
              return (
                <div key={item.key}>
                  {showDay ? (
                    <div className="bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
                      {dayFormatter.format(latestTs)}
                    </div>
                  ) : null}
                  <Link
                    href={item.href}
                    className="group grid min-w-0 gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="flex min-w-0 gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                        <ProviderIcon
                          providerKey={item.providerKey}
                          className="size-4"
                          fallback={<MessageSquareText className="size-4" />}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <Badge variant="secondary" className="text-[11px]">
                            {item.providerLabel}
                          </Badge>
                          {item.models.slice(0, MODEL_BADGE_MAX).map((model) => (
                            <Badge
                              key={model}
                              variant="outline"
                              className="max-w-52 truncate font-mono text-[11px]"
                              title={model}
                            >
                              {model}
                            </Badge>
                          ))}
                          {item.models.length > MODEL_BADGE_MAX ? (
                            <span className="text-muted-foreground text-xs" title={item.models.join(", ")}>
                              +{item.models.length - MODEL_BADGE_MAX}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 min-w-0 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere] group-hover:text-primary">
                          {item.preview}
                        </p>
                        <div className="text-muted-foreground mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <span>{item.turnLabel}</span>
                          {item.totalTokens !== null ? (
                            <span>{fmtCompact(item.totalTokens)} {item.tokenUnit}</span>
                          ) : (
                            <span>{item.noUsageLabel}</span>
                          )}
                          {item.hosts.length > 0 ? (
                            <span className="max-w-full truncate" title={item.hosts.join(", ")}>
                              {compactHistoryList(item.hosts, HOST_BADGE_MAX)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4 pl-11 sm:min-w-36 sm:flex-col sm:items-end sm:justify-center sm:gap-1 sm:pl-0">
                      {item.costLabel !== null ? (
                        <span className="text-sm font-semibold tabular-nums">{item.costLabel}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">{item.noUsageLabel}</span>
                      )}
                      <span className="text-muted-foreground text-xs tabular-nums" title={timestampFormatter.format(latestTs)}>
                        {timeFormatter.format(latestTs)}
                      </span>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">{labels.total}</span>
        {searchMode ? (
          nextHref ? (
            <Button asChild variant="outline" size="sm">
              <Link href={nextHref}>{labels.next}<ChevronRight className="size-4" /></Link>
            </Button>
          ) : null
        ) : pagination.totalPages > 1 ? (
          <div className="flex items-center gap-2">
            {pagination.hasPrev && prevHref ? (
              <Button asChild variant="outline" size="sm">
                <Link href={prevHref}><ChevronLeft className="size-4" />{labels.prev}</Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ChevronLeft className="size-4" />{labels.prev}
              </Button>
            )}
            <span className="text-muted-foreground text-sm tabular-nums">{labels.pageInfo}</span>
            {pagination.hasNext && nextHref ? (
              <Button asChild variant="outline" size="sm">
                <Link href={nextHref}>{labels.next}<ChevronRight className="size-4" /></Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                {labels.next}<ChevronRight className="size-4" />
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
