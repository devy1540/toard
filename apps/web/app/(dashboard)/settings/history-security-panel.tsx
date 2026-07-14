import { getLocale, getTranslations } from "next-intl/server";
import { KeyRound, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { E2EE_MAX_CIPHERTEXT_BYTES } from "@/lib/e2ee-contract";
import { withUserContext } from "@/lib/rls";
import { getViewerTimezone } from "@/lib/viewer-time";

type SecurityRow = {
  state: "pending" | "active";
  active_key_version: number;
  recovery_confirmed_at: Date | null;
  device_id: string | null;
  kind: "shim" | "browser" | null;
  label: string | null;
  platform: string | null;
  last_used_at: Date | null;
};

export async function HistorySecurityPanel({ userId }: { userId: string }) {
  const t = await getTranslations("settings.historySecurity");
  const { rows, legacyRecords, blockedRecords } = await withUserContext(userId, async (tx) => {
    const result = await tx.query<SecurityRow>(
      `SELECT account.state, account.active_key_version, account.recovery_confirmed_at,
              device.id AS device_id, device.kind, device.label, device.platform, device.last_used_at
       FROM content_accounts account
       LEFT JOIN content_devices device ON device.user_id = account.user_id
         AND device.approved_at IS NOT NULL AND device.revoked_at IS NULL
       WHERE account.user_id = $1
       ORDER BY device.created_at ASC`,
      [userId],
    );
    const counts = await tx.query<{ legacy_records: string; blocked_records: string }>(
      `SELECT COUNT(*) FILTER (WHERE encryption_scheme='server_v1')::text AS legacy_records,
              COUNT(*) FILTER (
                WHERE encryption_scheme='server_v1' AND octet_length(ciphertext) > $2
              )::text AS blocked_records
         FROM prompt_records WHERE user_id=$1`,
      [userId, E2EE_MAX_CIPHERTEXT_BYTES],
    );
    return {
      rows: result.rows,
      legacyRecords: Number(counts.rows[0]?.legacy_records ?? 0),
      blockedRecords: Number(counts.rows[0]?.blocked_records ?? 0),
    };
  });
  const account = rows[0];
  const locale = await getLocale();
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: await getViewerTimezone(), dateStyle: "medium", timeStyle: "short",
  });

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle>{t("title")}</CardTitle>
          <Badge variant={account?.state === "active" ? "secondary" : "outline"}>
            {account?.state === "active" ? t("active") : account ? t("pending") : t("off")}
          </Badge>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border p-3">
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs"><KeyRound className="size-3.5" />{t("keyVersion")}</dt>
            <dd className="mt-1 font-medium">{account ? `v${account.active_key_version}` : "—"}</dd>
          </div>
          <div className="min-w-0 rounded-lg border p-3">
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs"><ShieldCheck className="size-3.5" />{t("recoveryConfirmed")}</dt>
            <dd className="mt-1 break-words font-medium">
              {account?.recovery_confirmed_at ? formatter.format(account.recovery_confirmed_at) : "—"}
            </dd>
          </div>
        </dl>
        {account?.state === "active" ? (
          <p className="rounded-lg border p-3 text-sm">
            {legacyRecords > 0 && blockedRecords === legacyRecords
              ? t("legacyBlocked", { count: blockedRecords })
              : legacyRecords > 0
              ? t("legacyProtecting", { count: legacyRecords })
              : t("legacyComplete")}
          </p>
        ) : null}
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t("approvedDevices")}</h3>
          {rows.some((row) => row.device_id) ? (
            <ul className="mt-2 min-w-0 divide-y rounded-lg border">
              {rows.filter((row) => row.device_id).map((row) => (
                <li key={row.device_id!} className="flex min-w-0 items-center gap-3 p-3 text-sm">
                  <MonitorSmartphone className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{row.label}</span>
                    <span className="text-muted-foreground block truncate text-xs">{row.kind} · {row.platform}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {row.last_used_at ? formatter.format(row.last_used_at) : t("neverUsed")}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground mt-2 text-sm">{t("noDevices")}</p>}
        </div>
        <p className="text-muted-foreground text-xs">{t("noDestructiveActions")}</p>
      </CardContent>
    </Card>
  );
}
