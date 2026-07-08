import { redirect } from "next/navigation";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionDefaultOn, contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { fmtNum } from "@/lib/format";
import { getViewerTimezone } from "@/lib/viewer-time";
import { getHostShims, getLatestShimVersion } from "@/lib/host-shims";
import { getIngestEndpoint, getPublicBaseUrl } from "@/lib/public-url";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta } from "@/lib/tokens";
import { getServerVersion } from "@/lib/version";
import type { DeviceInfo } from "@toard/core";
import { formatVersion, isShimOutdated } from "@toard/core";
import { AppearanceForm } from "./appearance-form";
import { ConnectionCheck } from "./connection-check";
import { OnboardingPanel } from "./onboarding-panel";
import { PasswordForm } from "./password-form";
import { TimezoneForm } from "./timezone-form";

export const dynamic = "force-dynamic";

type Tab = "account" | "install";

/** 설정 — 계정·설치 탭 (멤버 관리는 /admin 으로 분리, 역할 축 개편). */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("settings");
  // 실제 세션 필수 — 폴백 신원으로는 접근 불가.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const r = await getPool().query<{ email: string; password_hash: string | null; timezone: string | null }>(
    "SELECT email, password_hash, timezone FROM users WHERE id = $1",
    [userId],
  );
  const email = r.rows[0]?.email ?? null;
  const hasPassword = Boolean(r.rows[0]?.password_hash);
  const timezone = r.rows[0]?.timezone ?? null;

  const tab: Tab = (await searchParams).tab === "install" ? "install" : "account";

  // 페이지 전체(상단 행 포함)를 탭 폭에 맞는 중앙 컨테이너로 — 와이드 화면에서
  // 콘텐츠만 폭을 제한하면 좌측 쏠림 + 우측 사막이 된다(상단 요소도 화면 끝으로 흩어짐).
  return (
    <div className={tab === "account" ? "mx-auto w-full max-w-2xl space-y-6" : "mx-auto w-full max-w-5xl space-y-6"}>
      {/* 대시보드와 같은 한 줄 상단 문법 — 작은 제목 + 탭, 우측에 계정 컨텍스트 */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-medium">{t("pageTitle")}</h1>
        <LinkTabs
          active={tab}
          tabs={[
            { value: "account", label: t("tabAccount"), href: "/settings?tab=account" },
            { value: "install", label: t("tabInstall"), href: "/settings?tab=install" },
          ]}
        />
        {email ? <span className="text-muted-foreground ml-auto text-xs">{email}</span> : null}
      </div>

      {tab === "account" ? (
        <AccountTab hasPassword={hasPassword} timezone={timezone} />
      ) : (
        <InstallTab userId={userId} />
      )}
    </div>
  );
}

async function AccountTab({ hasPassword, timezone }: { hasPassword: boolean; timezone: string | null }) {
  const t = await getTranslations("settings");
  // 설정성 폼은 좁은 단일 컬럼 스택 — 높이가 다른 카드를 그리드에 넣으면 빈 공간이 널뛴다.
  // 순서는 사용 빈도순: 모양(개인화) → 타임존 → 비밀번호.
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("appearance.title")}</CardTitle>
          <CardDescription>{t("appearance.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("timezone.title")}</CardTitle>
          <CardDescription>{t("timezone.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TimezoneForm initial={timezone} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{hasPassword ? t("account.changeTitle") : t("account.setTitle")}</CardTitle>
          <CardDescription>
            {hasPassword ? t("account.changeDescription") : t("account.setDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm hasPassword={hasPassword} />
        </CardContent>
      </Card>
    </div>
  );
}

async function InstallTab({ userId }: { userId: string }) {
  const t = await getTranslations("settings");
  const [meta, endpoint, baseUrl, devices, shims, latestShim] = await Promise.all([
    getActiveTokenMeta(userId),
    getIngestEndpoint(),
    getPublicBaseUrl(),
    getStorage().getUserHosts(userId),
    getHostShims(userId),
    getLatestShimVersion(userId),
  ]);
  const serverVersion = getServerVersion();
  const contentEnabled = contentCollectionEnabled();
  const contentDefaultOn = contentCollectionDefaultOn();

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("install.issueTitle")}</CardTitle>
            <CardDescription>
              {t.rich(
                contentEnabled ? "install.issueDescriptionWithContent" : "install.issueDescription",
                {
                  code: (chunks) => <code>{chunks}</code>,
                  b: (chunks) => <b>{chunks}</b>,
                },
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
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

        <Card>
          <CardHeader>
            <CardTitle>{t("install.checkTitle")}</CardTitle>
            <CardDescription>{t("install.checkDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ConnectionCheck
              initialHasToken={Boolean(meta)}
              initialLastUsedAt={meta?.lastUsedAt?.toISOString() ?? null}
              initialShimVersion={latestShim}
              serverVersion={serverVersion}
            />
            <div className="text-muted-foreground space-y-1 border-t pt-3 text-sm">
              <p>{t.rich("install.hintWhich", { code: (chunks) => <code>{chunks}</code> })}</p>
              <p>
                {t.rich("install.hintUsage", {
                  code: (chunks) => <code>{chunks}</code>,
                  link: (chunks) => (
                    <Link className="text-primary underline-offset-4 hover:underline" href="/">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
              <p>{t("install.hintPrereq")}</p>
            </div>
          </CardContent>
        </Card>
      </div>

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
    <Card>
      <CardHeader>
        <CardTitle>{t("install.devicesTitle")}</CardTitle>
        <CardDescription>
          {t.rich("install.devicesDescription", {
            code: (chunks) => <code>{chunks}</code>,
            b: (chunks) => <b>{chunks}</b>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {devices.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("install.deviceComputer")}</TableHead>
                <TableHead className="text-right">{t("install.deviceEvents")}</TableHead>
                <TableHead>{t("install.deviceShim")}</TableHead>
                <TableHead className="text-right">{t("install.deviceLastSeen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => {
                const shim = d.host ? shims.get(d.host) : undefined;
                return (
                  <TableRow key={d.host ?? "__unknown__"}>
                    <TableCell className={d.host ? "font-medium" : "text-muted-foreground"}>
                      {d.host ?? t("install.unknownHost")}
                    </TableCell>
                    <TableCell className="text-right">{fmtNum(d.eventCount)}</TableCell>
                    <TableCell>
                      {shim ? (
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{formatVersion(shim.version)}</span>
                          {isShimOutdated(shim.version, serverVersion) ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500"
                            >
                              {t("install.shimOutdated")}
                            </Badge>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("install.shimUnreported")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {fmtWhen.format(d.lastSeenAt)}
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
