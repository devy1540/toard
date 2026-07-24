import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { oauthProviders, signIn } from "@/auth";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { SettingsRow } from "@/components/dashboard/settings-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionDefaultOn, contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { fmtNum } from "@/lib/format";
import { getViewerTimezone } from "@/lib/viewer-time";
import { getHostShims } from "@/lib/host-shims";
import { getPublicBaseUrl, getRequestOrigin } from "@/lib/public-url";
import { getDashboardViewer } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";
import { getMyDeviceInventories } from "@/lib/tool-metadata";
import { listActiveTokens } from "@/lib/tokens";
import { getServerVersion } from "@/lib/version";
import { getMfaStatus } from "@/lib/mfa-store";
import { getDeviceControlRepository, type DeviceControlView } from "@/lib/device-control-repository";
import { buildSettingsDeviceRows } from "@/lib/settings-device-rows";
import type { DeviceInfo } from "@toard/core";
import { formatVersion, isShimOutdated } from "@toard/core";
import { AppearanceForm } from "./appearance-form";
import { DeviceActions, type DeviceControlClientView } from "./device-actions";
import { DeviceInventory } from "./device-inventory";
import { OnboardingPanel } from "./onboarding-panel";
import { OnboardingWizard } from "./onboarding-wizard";
import { PasswordForm } from "./password-form";
import { TimezoneForm } from "./timezone-form";
import { TokenManagementPanel, type TokenManagementRow } from "./token-management-panel";
import { HistorySecurityPanel } from "./history-security-panel";
import { MfaSettingsPanel } from "./mfa-settings-panel";

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
        <AccountTab userId={userId} hasPassword={hasPassword} linkedProviders={linkedProviders} timezone={timezone} />
      ) : (
        <InstallTab userId={userId} />
      )}
    </div>
  );
}

async function AccountTab({
  userId,
  hasPassword,
  linkedProviders,
  timezone,
}: {
  userId: string;
  hasPassword: boolean;
  linkedProviders: string[];
  timezone: string | null;
}) {
  const t = await getTranslations("settings");
  const googleConfigured = oauthProviders.includes("google");
  const googleLinked = linkedProviders.includes("google");
  const mfaStatus = (process.env.AUTH_MODE ?? "oauth") !== "open" ? await getMfaStatus(userId) : null;
  return (
    <div className="min-w-0 space-y-4">
      {(process.env.AUTH_MODE ?? "oauth") !== "open" ? <HistorySecurityPanel userId={userId} /> : null}
      {mfaStatus ? <MfaSettingsPanel initial={{ status: mfaStatus }} hasPassword={hasPassword} /> : null}
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
          <SettingsRow
            layout="settings"
            className="gap-4 lg:items-start"
            label={t("loginMethods.google")}
            description={t("loginMethods.googleDescription")}
          >
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
          </SettingsRow>

          <SettingsRow
            layout="settings"
            className="gap-4 lg:items-start"
            label={hasPassword ? t("account.changeTitle") : t("account.setTitle")}
            description={hasPassword ? t("account.changeDescription") : t("account.setDescription")}
          >
            <PasswordForm hasPassword={hasPassword} />
          </SettingsRow>
        </CardContent>
      </Card>
    </div>
  );
}

async function InstallTab({ userId }: { userId: string }) {
  const t = await getTranslations("settings");
  const [tokens, baseUrl, uiOrigin, devices, shims, inventories, controls] = await Promise.all([
    listActiveTokens(userId),
    getPublicBaseUrl(),
    getRequestOrigin(),
    getStorage().getUserHosts(userId),
    getHostShims(userId),
    getMyDeviceInventories(userId),
    getDeviceControlRepository().listUserDevices(userId),
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
          <CardDescription>{t("install.issueDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-6">
          <OnboardingWizard
            baseUrl={baseUrl}
            uiOrigin={uiOrigin}
            contentEnabled={contentEnabled}
            contentDefaultOn={contentDefaultOn}
          />
          <div className="border-t pt-4">
            <OnboardingPanel baseUrl={baseUrl} uiOrigin={uiOrigin} />
          </div>
        </CardContent>
      </Card>

      <TokenManagementPanel tokens={tokenRows} />
      <DeviceList
        devices={devices}
        shims={shims}
        inventories={inventories}
        controls={controls}
        serverVersion={serverVersion}
        contentEnabled={contentEnabled}
      />
    </div>
  );
}

async function DeviceList({
  devices,
  shims,
  inventories,
  controls,
  serverVersion,
  contentEnabled,
}: {
  devices: DeviceInfo[];
  shims: Map<string, { version: string; lastSeenAt: Date }>;
  inventories: import("@toard/core").DeviceToolInventory[];
  controls: DeviceControlView[];
  serverVersion: string;
  contentEnabled: boolean;
}) {
  const t = await getTranslations("settings");
  const locale = await getLocale();
  const fmtWhen = new Intl.DateTimeFormat(locale, {
    timeZone: await getViewerTimezone(),
    dateStyle: "medium",
    timeStyle: "short",
  });
  const rows = buildSettingsDeviceRows(devices, inventories, controls);
  const staleBefore = Date.now() - 15 * 60 * 1000;
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
        {rows.length > 0 ? (
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
              {rows.map((row) => {
                const hostShim = row.host ? shims.get(row.host) : undefined;
                const shimVersion = row.control?.shimVersion ?? hostShim?.version ?? null;
                const syncStale =
                  row.control?.lastSyncAt != null &&
                  row.control.lastSyncAt.getTime() < staleBefore;
                const outdated = shimVersion
                  ? isShimOutdated(shimVersion, serverVersion)
                  : false;
                const control = row.control;
                const controlView: DeviceControlClientView | null = control
                  ? {
                      tokenId: control.tokenId,
                      deviceFingerprint: control.deviceFingerprint,
                      desiredGeneration: control.desiredGeneration,
                      desiredContentMode: control.desiredContentMode,
                      appliedGeneration: control.appliedGeneration,
                      appliedContentMode: control.appliedContentMode,
                      daemonActive: control.daemonActive,
                      lastSyncAt: control.lastSyncAt?.toISOString() ?? null,
                      lastSyncLabel: control.lastSyncAt
                        ? fmtWhen.format(control.lastSyncAt)
                        : null,
                      syncStale,
                      command: control.command
                        ? {
                            type: control.command.type,
                            status: control.command.status,
                            resultCode: control.command.resultCode,
                          }
                        : null,
                    }
                  : null;
                return (
                  <TableRow key={row.key}>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={
                            control?.lastSyncAt && !syncStale
                              ? "size-2 shrink-0 rounded-full bg-emerald-500"
                              : "bg-muted-foreground/40 size-2 shrink-0 rounded-full"
                          }
                        />
                        <span
                          className={row.host ? "truncate font-medium" : "text-muted-foreground"}
                        >
                          {row.host ?? t("install.unknownHost")}
                        </span>
                        {row.inventory ? (
                          <span className="text-muted-foreground font-mono text-[11px]">
                            #{row.inventory.fingerprint.slice(0, 8)}
                          </span>
                        ) : null}
                      </span>
                      {row.sharedHost ? (
                        <span className="text-amber-600 mt-1 block text-xs dark:text-amber-500">
                          {t("install.sharedHost")}
                        </span>
                      ) : null}
                      <DeviceInventory inventory={row.inventory ?? undefined} />
                    </TableCell>
                    <TableCell className="text-right">
                      {row.sharedHost || !row.device ? "—" : fmtNum(row.device.eventCount)}
                    </TableCell>
                    <TableCell>
                      {shimVersion ? (
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{formatVersion(shimVersion)}</span>
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
                      {row.sharedHost || !row.device
                        ? "—"
                        : fmtWhen.format(row.device.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DeviceActions
                        control={controlView}
                        contentEnabled={contentEnabled}
                        pollWhenMissing={row.inventory != null}
                      />
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
