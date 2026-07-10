import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { oauthProviders, signIn } from "@/auth";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionDefaultOn, contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { fmtNum } from "@/lib/format";
import { getViewerTimezone } from "@/lib/viewer-time";
import { getHostShims } from "@/lib/host-shims";
import { getIngestEndpoint, getPublicBaseUrl } from "@/lib/public-url";
import { getDashboardViewer } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta, listActiveTokens } from "@/lib/tokens";
import { getServerVersion } from "@/lib/version";
import type { DeviceInfo } from "@toard/core";
import { formatVersion, isShimOutdated } from "@toard/core";
import { AppearanceForm } from "./appearance-form";
import { DeviceActions } from "./device-actions";
import { OnboardingPanel } from "./onboarding-panel";
import { PasswordForm } from "./password-form";
import { TimezoneForm } from "./timezone-form";
import { TokenManagementPanel, type TokenManagementRow } from "./token-management-panel";

export const dynamic = "force-dynamic";

type Tab = "account" | "install";

/** 설정 — 계정·설치 탭 (멤버 관리는 /admin 으로 분리, 역할 축 개편). */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("settings");
  // open/demo 모드에서는 대시보드와 같은 viewer 폴백으로 설정 화면까지 확인 가능하게 한다.
  const viewer = await getDashboardViewer();
  if (!viewer) redirect("/login");
  const userId = viewer.id;

  const r = await getPool().query<{ email: string; password_hash: string | null; timezone: string | null }>(
    "SELECT email, password_hash, timezone FROM users WHERE id = $1",
    [userId],
  );
  const email = r.rows[0]?.email ?? null;
  const hasPassword = Boolean(r.rows[0]?.password_hash);
  const timezone = r.rows[0]?.timezone ?? null;
  const accounts = await getPool().query<{ provider: string }>(
    `SELECT provider FROM accounts WHERE "userId" = $1 ORDER BY provider`,
    [userId],
  );
  const linkedProviders = accounts.rows.map((x) => x.provider);

  const tab: Tab = (await searchParams).tab === "install" ? "install" : "account";

  return (
    <div className="space-y-6">
      {/* 대시보드와 같은 한 줄 상단 문법 — 작은 제목 + 탭, 우측에 계정 컨텍스트 */}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="text-sm font-medium">{t("pageTitle")}</h1>
        <LinkTabs
          active={tab}
          tabs={[
            { value: "account", label: t("tabAccount"), href: "/settings?tab=account" },
            { value: "install", label: t("tabInstall"), href: "/settings?tab=install" },
          ]}
        />
        {email ? <span className="text-muted-foreground max-w-full truncate text-xs sm:ml-auto">{email}</span> : null}
      </div>

      {tab === "account" ? (
        <AccountTab hasPassword={hasPassword} linkedProviders={linkedProviders} timezone={timezone} />
      ) : (
        <InstallTab userId={userId} />
      )}
    </div>
  );
}

async function AccountTab({
  hasPassword,
  linkedProviders,
  timezone,
}: {
  hasPassword: boolean;
  linkedProviders: string[];
  timezone: string | null;
}) {
  const t = await getTranslations("settings");
  const googleConfigured = oauthProviders.includes("google");
  const googleLinked = linkedProviders.includes("google");
  return (
    <div className="min-w-0 space-y-4">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("appearance.title")}</CardTitle>
          <CardDescription>{t("appearance.description")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 divide-y">
          <AppearanceForm timezoneControl={<TimezoneForm initial={timezone} />} />
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("loginMethods.title")}</CardTitle>
          <CardDescription>{t("loginMethods.description")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 divide-y">
          <section className="grid min-w-0 gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("loginMethods.google")}</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-xs">{t("loginMethods.googleDescription")}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 self-center">
              <Badge variant={googleLinked ? "secondary" : "outline"}>
                {googleLinked ? t("loginMethods.connected") : t("loginMethods.notConnected")}
              </Badge>
              {googleConfigured && !googleLinked ? (
                <form
                  action={async () => {
                    "use server";
                    await signIn("google", { redirectTo: "/settings?tab=account" });
                  }}
                >
                  <Button type="submit" variant="outline" size="sm">
                    {t("loginMethods.connectGoogle")}
                  </Button>
                </form>
              ) : null}
              {!googleConfigured ? (
                <span className="text-muted-foreground text-sm">{t("loginMethods.googleNotConfigured")}</span>
              ) : null}
            </div>
          </section>

          <section className="grid min-w-0 gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{hasPassword ? t("account.changeTitle") : t("account.setTitle")}</h2>
              <p className="text-muted-foreground mt-1 max-w-sm text-xs">
                {hasPassword ? t("account.changeDescription") : t("account.setDescription")}
              </p>
            </div>
            <PasswordForm hasPassword={hasPassword} />
          </section>
        </CardContent>
      </Card>
    </div>
  );
}

async function InstallTab({ userId }: { userId: string }) {
  const t = await getTranslations("settings");
  const [meta, tokens, endpoint, baseUrl, devices, shims] = await Promise.all([
    getActiveTokenMeta(userId),
    listActiveTokens(userId),
    getIngestEndpoint(),
    getPublicBaseUrl(),
    getStorage().getUserHosts(userId),
    getHostShims(userId),
  ]);
  const serverVersion = getServerVersion();
  const contentEnabled = contentCollectionEnabled();
  const contentDefaultOn = contentCollectionDefaultOn();
  const locale = await getLocale();
  const fmtWhen = new Intl.DateTimeFormat(locale, {
    timeZone: await getViewerTimezone(),
    dateStyle: "medium",
    timeStyle: "short",
  });
  const tokenRows: TokenManagementRow[] = tokens.map((token) => ({
    id: token.id,
    label: token.label,
    lastHost: token.lastHost,
    createdAt: fmtWhen.format(token.createdAt),
    lastUsedAt: token.lastUsedAt ? fmtWhen.format(token.lastUsedAt) : null,
  }));

  return (
    <div className="space-y-4">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("install.issueTitle")}</CardTitle>
          <CardDescription>
            {t.rich(contentEnabled ? "install.issueDescriptionWithContent" : "install.issueDescription", {
              code: (chunks) => <code>{chunks}</code>,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <OnboardingPanel
            baseUrl={baseUrl}
            endpoint={endpoint}
            hasToken={Boolean(meta)}
            createdAt={meta?.createdAt.toISOString() ?? null}
            lastUsedAt={meta?.lastUsedAt?.toISOString() ?? null}
            contentEnabled={contentEnabled}
            contentDefaultOn={contentDefaultOn}
          />
        </CardContent>
      </Card>

      <TokenManagementPanel tokens={tokenRows} />
      <DeviceList devices={devices} shims={shims} serverVersion={serverVersion} />
    </div>
  );
}

async function DeviceList({
  devices,
  shims,
  serverVersion,
}: {
  devices: DeviceInfo[];
  shims: Map<string, { version: string; lastSeenAt: Date }>;
  serverVersion: string;
}) {
  const t = await getTranslations("settings");
  const locale = await getLocale();
  const fmtWhen = new Intl.DateTimeFormat(locale, {
    timeZone: await getViewerTimezone(),
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("install.devicesTitle")}</CardTitle>
        <CardDescription>
          {t.rich("install.devicesDescription", {
            code: (chunks) => <code>{chunks}</code>,
            b: (chunks) => <b>{chunks}</b>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        {devices.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("install.deviceComputer")}</TableHead>
                <TableHead className="text-right">{t("install.deviceEvents")}</TableHead>
                <TableHead>{t("install.deviceShim")}</TableHead>
                <TableHead className="text-right">{t("install.deviceLastSeen")}</TableHead>
                <TableHead className="text-right">{t("install.deviceActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => {
                const shim = d.host ? shims.get(d.host) : undefined;
                const outdated = shim ? isShimOutdated(shim.version, serverVersion) : false;
                const primaryAction = !shim ? "doctor" : outdated ? "update" : "collect";
                return (
                  <TableRow key={d.host ?? "__unknown__"}>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={
                            shim
                              ? "size-2 shrink-0 rounded-full bg-emerald-500"
                              : "bg-muted-foreground/40 size-2 shrink-0 rounded-full"
                          }
                        />
                        <span className={d.host ? "truncate font-medium" : "text-muted-foreground"}>
                          {d.host ?? t("install.unknownHost")}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{fmtNum(d.eventCount)}</TableCell>
                    <TableCell>
                      {shim ? (
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{formatVersion(shim.version)}</span>
                          {outdated ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500"
                            >
                              {t("install.shimOutdated")}
                            </Badge>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("install.shimUnreported")}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {fmtWhen.format(d.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DeviceActions primary={primaryAction} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t.rich("install.noDevices", { code: (chunks) => <code>{chunks}</code> })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
