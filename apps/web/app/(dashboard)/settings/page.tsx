import { redirect } from "next/navigation";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { fmtNum } from "@/lib/format";
import { getOrgTimezone } from "@/lib/org-time";
import { getIngestEndpoint, getPublicBaseUrl } from "@/lib/public-url";
import { getStorage } from "@/lib/storage";
import { getActiveTokenMeta } from "@/lib/tokens";
import type { DeviceInfo } from "@toard/core";
import { ConnectionCheck } from "./connection-check";
import { OnboardingPanel } from "./onboarding-panel";
import { PasswordForm } from "./password-form";

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

  const r = await getPool().query<{ email: string; password_hash: string | null }>(
    "SELECT email, password_hash FROM users WHERE id = $1",
    [userId],
  );
  const email = r.rows[0]?.email ?? null;
  const hasPassword = Boolean(r.rows[0]?.password_hash);

  const tab: Tab = (await searchParams).tab === "install" ? "install" : "account";

  return (
    <div className="space-y-6">
      <PageHeader title={t("pageTitle")} description={email ?? undefined} />

      <LinkTabs
        active={tab}
        tabs={[
          { value: "account", label: t("tabAccount"), href: "/settings?tab=account" },
          { value: "install", label: t("tabInstall"), href: "/settings?tab=install" },
        ]}
      />

      {tab === "account" ? (
        <AccountTab hasPassword={hasPassword} />
      ) : (
        <InstallTab userId={userId} />
      )}
    </div>
  );
}

async function AccountTab({ hasPassword }: { hasPassword: boolean }) {
  const t = await getTranslations("settings");
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
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
  const [meta, endpoint, baseUrl, devices] = await Promise.all([
    getActiveTokenMeta(userId),
    getIngestEndpoint(),
    getPublicBaseUrl(),
    getStorage().getUserHosts(userId),
  ]);
  const contentEnabled = contentCollectionEnabled();

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

      <DeviceList devices={devices} />
    </div>
  );
}

async function DeviceList({ devices }: { devices: DeviceInfo[] }) {
  const t = await getTranslations("settings");
  const locale = await getLocale();
  const fmtWhen = new Intl.DateTimeFormat(locale, {
    timeZone: getOrgTimezone(),
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
                <TableHead className="text-right">{t("install.deviceLastSeen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => (
                <TableRow key={d.host ?? "__unknown__"}>
                  <TableCell className={d.host ? "font-medium" : "text-muted-foreground"}>
                    {d.host ?? t("install.unknownHost")}
                  </TableCell>
                  <TableCell className="text-right">{fmtNum(d.eventCount)}</TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {fmtWhen.format(d.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
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
