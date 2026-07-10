import type { ToolActivityRow } from "@toard/core";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtNum } from "@/lib/format";

export async function ToolActivityList({ rows, timezone }: { rows: ToolActivityRow[]; timezone: string }) {
  const t = await getTranslations("dashboard.toolActivity");
  const locale = await getLocale();
  const when = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  if (rows.length === 0) {
    return <Card><CardContent className="text-muted-foreground py-8 text-center text-sm">{t("empty")}</CardContent></Card>;
  }
  return (
    <Card className="min-w-0">
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t("name")}</TableHead><TableHead>{t("kind")}</TableHead><TableHead>{t("evidence")}</TableHead>
            <TableHead className="text-right">{t("callCount")}</TableHead><TableHead>{t("outcome")}</TableHead><TableHead>{t("lastActivity")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.activityKind}:${row.itemKey}:${row.detection}`}>
                <TableCell><div className="font-medium">{row.displayName}</div>{row.pluginKey ? <div className="text-muted-foreground text-xs">{row.pluginKey}</div> : null}</TableCell>
                <TableCell>{t(row.activityKind === "mcp" ? "mcpLabel" : "skillLabel")}</TableCell>
                <TableCell><Badge variant="outline">{t(row.detection === "explicit" ? "explicitBadge" : "loadedBadge")}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{fmtNum(row.calls)}</TableCell>
                <TableCell className="text-xs">{t("outcomeSummary", { success: row.successes, failure: row.failures, unknown: row.unknown })}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">{when.format(row.lastActivityAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
