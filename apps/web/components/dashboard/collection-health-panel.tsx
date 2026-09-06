import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CollectionHealthRow } from "@/lib/collection-health";

export async function CollectionHealthPanel({ rows, formatTime }: { rows: CollectionHealthRow[]; formatTime: (date: Date) => string }) {
  const t = await getTranslations("settings");
  const number = (value: number | null) => value == null ? "—" : value.toLocaleString();
  return (
    <Card data-collection-health="personal">
      <CardHeader><CardTitle>{t("health.title")}</CardTitle><CardDescription>{t("health.description")}</CardDescription></CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-muted-foreground text-sm">{t("health.empty")}</p> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t("health.computer")}</TableHead><TableHead>{t("health.provider")}</TableHead>
              <TableHead>{t("health.state")}</TableHead><TableHead>{t("health.lastStored")}</TableHead>
              <TableHead>{t("health.lastReport")}</TableHead><TableHead>{t("health.parsed")}</TableHead>
              <TableHead>{t("health.failures")}</TableHead><TableHead>{t("health.pending")}</TableHead>
            </TableRow></TableHeader>
            <TableBody>{rows.map((row) => (
              <TableRow key={`${row.tokenId}:${row.provider}`}>
                <TableCell>{row.computer ?? t("health.unnamed")}</TableCell><TableCell>{row.provider}</TableCell>
                <TableCell>
                  {t(`health.states.${row.state ?? "unknown"}`)}
                  {row.scannedFiles != null ? <p className="text-muted-foreground text-xs">{t("health.scanned", { count: number(row.scannedFiles) })}</p> : null}
                  {row.lastReportAt && Date.now() - row.lastReportAt.getTime() > 20 * 60_000 ? <p className="text-muted-foreground text-xs">{t("health.stale")}</p> : null}
                  {row.errorCode ? <p className="text-muted-foreground text-xs">{t(`health.errors.${row.errorCode}`)}</p> : null}
                </TableCell>
                <TableCell>{row.lastStoredAt ? formatTime(row.lastStoredAt) : t("health.noReceipt")}</TableCell>
                <TableCell>{row.lastReportAt ? formatTime(row.lastReportAt) : "—"}</TableCell>
                <TableCell>{number(row.parsedEvents)}</TableCell><TableCell>{number(row.parseErrors)}</TableCell><TableCell>{number(row.pendingEvents)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
