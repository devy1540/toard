import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AlertTriangle } from "lucide-react";
import { formatVersion, isShimOutdated } from "@toard/core";
import { Badge } from "@/components/ui/badge";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { listAllHostShims, worstShimByUser } from "@/lib/host-shims";
import { listPendingInvites } from "@/lib/invites";
import { getPricingStatus } from "@/lib/pricing";
import { getPublicBaseUrl } from "@/lib/public-url";
import { getSessionUser } from "@/lib/session-user";
import { getServerVersion } from "@/lib/version";
import { PricingSyncPanel } from "./pricing-panel";
import { TeamPanel, type TeamRow } from "./team-panel";
import { TeamSelect } from "./team-select";
import { InvitePanel } from "./invite-panel";

export const dynamic = "force-dynamic";

type Tab = "members" | "teams" | "invites" | "system";

interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  team_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

/** 멤버 목록 + 활성 토큰의 마지막 수신 시각(수집 연결 상태 확인용) */
async function listMembers(): Promise<MemberRow[]> {
  const r = await getPool().query<MemberRow>(
    `SELECT u.id, u.email, u.name, u.role, u.team_id, u.created_at, t.last_used_at
     FROM users u
     LEFT JOIN LATERAL (
       SELECT max(last_used_at) AS last_used_at
       FROM ingest_tokens
       WHERE user_id = u.id AND revoked_at IS NULL
     ) t ON true
     ORDER BY u.created_at`,
  );
  return r.rows;
}

/** 팀 목록 + 소속 인원 + 수집 이력 존재 여부(삭제 가능 판정) */
async function listTeams(): Promise<TeamRow[]> {
  const r = await getPool().query<{ id: string; name: string; member_count: string; has_events: boolean }>(
    `SELECT d.id, d.name,
            (SELECT count(*) FROM users u WHERE u.team_id = d.id) AS member_count,
            EXISTS(SELECT 1 FROM usage_events e WHERE e.team_id = d.id) AS has_events
     FROM teams d
     ORDER BY d.name`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    memberCount: Number(x.member_count),
    hasEvents: x.has_events,
  }));
}

function fmtDate(d: Date | null): string {
  return d ? new Date(d).toLocaleDateString() : "—";
}

/** 관리 (admin 전용) — 멤버·팀·초대 탭. 수집 상태·도구 관리는 후속 확장 자리(§9 로드맵). */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const raw = (await searchParams).tab;
  const tab: Tab =
    raw === "teams" ? "teams" : raw === "invites" ? "invites" : raw === "system" ? "system" : "members";

  const t = await getTranslations("admin");

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <LinkTabs
        active={tab}
        tabs={[
          { value: "members", label: t("tabs.members"), href: "/admin?tab=members" },
          { value: "teams", label: t("tabs.teams"), href: "/admin?tab=teams" },
          { value: "invites", label: t("tabs.invites"), href: "/admin?tab=invites" },
          { value: "system", label: t("tabs.system"), href: "/admin?tab=system" },
        ]}
      />

      {tab === "members" ? <MembersTab /> : null}
      {tab === "teams" ? <TeamsTab /> : null}
      {tab === "invites" ? <InvitesTab /> : null}
      {tab === "system" ? <SystemTab /> : null}
    </div>
  );
}

async function MembersTab() {
  const [members, teams, shimRows, t] = await Promise.all([
    listMembers(),
    listTeams(),
    listAllHostShims(),
    getTranslations("admin"),
  ]);
  const deptOptions = teams.map((d) => ({ id: d.id, name: d.name }));
  const serverVersion = getServerVersion();
  // 멤버 행에는 그 멤버 기기들 중 가장 뒤처진 버전을 표시 (기기별 상세는 본인 설정 화면)
  const worst = worstShimByUser(shimRows);
  const outdatedDevices = shimRows.filter((r) =>
    isShimOutdated(r.shimVersion, serverVersion),
  ).length;

  return (
    <div className="space-y-4">
      {outdatedDevices > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <span>{t("members.outdatedBanner", { count: outdatedDevices })}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("members.cardTitle", { count: members.length })}</CardTitle>
          <CardDescription>{t("members.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("members.colMember")}</TableHead>
                <TableHead>{t("members.colRole")}</TableHead>
                <TableHead>{t("members.colTeam")}</TableHead>
                <TableHead>{t("members.colShim")}</TableHead>
                <TableHead className="text-right">{t("members.colLastReceived")}</TableHead>
                <TableHead className="text-right">{t("members.colJoined")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const v = worst.get(m.id);
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.name ?? m.email}</div>
                      {m.name ? <div className="text-muted-foreground text-xs">{m.email}</div> : null}
                    </TableCell>
                    <TableCell>
                      {m.role === "admin" ? <Badge variant="secondary">admin</Badge> : <span className="text-muted-foreground">member</span>}
                    </TableCell>
                    <TableCell>
                      <TeamSelect userId={m.id} current={m.team_id} teams={deptOptions} />
                    </TableCell>
                    <TableCell>
                      {v ? (
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{formatVersion(v)}</span>
                          {isShimOutdated(v, serverVersion) ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500"
                            >
                              {t("members.shimOutdated")}
                            </Badge>
                          ) : null}
                        </span>
                      ) : m.last_used_at ? (
                        // 수신 이력은 있는데 버전 미보고 = User-Agent 를 안 보내는 구 shim
                        <span className="text-muted-foreground">{t("members.shimUnreported")}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">{fmtDate(m.last_used_at)}</TableCell>
                    <TableCell className="text-muted-foreground text-right">{fmtDate(m.created_at)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

async function TeamsTab() {
  const [teams, t] = await Promise.all([listTeams(), getTranslations("admin")]);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("teams.cardTitle", { count: teams.length })}</CardTitle>
          <CardDescription>{t("teams.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TeamPanel teams={teams} />
        </CardContent>
      </Card>
    </div>
  );
}

async function SystemTab() {
  const [pricing, t] = await Promise.all([getPricingStatus(), getTranslations("admin")]);
  const contentEnabled = contentCollectionEnabled();

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("system.serverTitle")}</CardTitle>
          <CardDescription>{t("system.serverDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t("system.serverVersion")}</span>
            <span className="font-mono">{formatVersion(getServerVersion())}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("system.pricingTitle")}</CardTitle>
          <CardDescription>{t("system.pricingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <PricingSyncPanel models={pricing.models} lastDay={pricing.lastDay} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("system.contentTitle")}
            {contentEnabled ? (
              <Badge variant="secondary">{t("system.contentBadgeOn")}</Badge>
            ) : (
              <Badge variant="outline">{t("system.contentBadgeOff")}</Badge>
            )}
          </CardTitle>
          <CardDescription>{t("system.contentDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {contentEnabled ? (
            <p className="text-muted-foreground">
              {t.rich("system.contentEnabledBody", { code: (chunks) => <code>{chunks}</code> })}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">{t("system.contentSetupHint")}</p>
              <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                TOARD_CONTENT_KEK_B64=$(openssl rand -base64 32)
              </pre>
              <p className="text-muted-foreground text-xs">
                {t.rich("system.contentSetupNote", { code: (chunks) => <code>{chunks}</code> })}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

async function InvitesTab() {
  const [baseUrl, pending, t] = await Promise.all([
    getPublicBaseUrl(),
    listPendingInvites(),
    getTranslations("admin"),
  ]);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("invites.cardTitle")}</CardTitle>
          <CardDescription>{t("invites.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <InvitePanel
            baseUrl={baseUrl}
            pending={pending.map((p) => ({
              email: p.email,
              role: p.role,
              expiresAt: p.expiresAt.toISOString(),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
