import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AlertTriangle } from "lucide-react";
import { formatVersion, isShimOutdated } from "@toard/core";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { SettingsRow } from "@/components/dashboard/settings-row";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contentCollectionEnabled } from "@/lib/content-crypto";
import { getPool } from "@/lib/db";
import { listAllHostShims, worstShimByUser } from "@/lib/host-shims";
import { listPendingInvites } from "@/lib/invites";
import { getPricingAdminStatus } from "@/lib/pricing-admin-status";
import { schedulerEligible } from "@/lib/pricing-auto-sync";
import { getPublicBaseUrl } from "@/lib/public-url";
import { getRollupAdminStatus } from "@/lib/rollup-status";
import { getLegacyRetirementStatus } from "@/lib/e2ee-legacy-retirement";
import { getEncryptionAdminStatus } from "@/lib/encryption-admin-status";
import { getServerUpdateStatus } from "@/lib/server-update";
import { getSessionUser } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";
import { getTeamAttributionStatus } from "@/lib/team-attribution";
import { getServerVersion } from "@/lib/version";
import { PricingSyncPanel } from "./pricing-panel";
import { RoleSelect } from "./role-select";
import { RollupStatusPanel } from "./rollup-status-panel";
import { ServerUpdatePanel } from "./server-update-panel";
import { TeamPanel, type TeamRow } from "./team-panel";
import { TeamSelect } from "./team-select";
import { InvitePanel } from "./invite-panel";
import { LegacyRetirementPanel } from "./legacy-retirement-panel";
import { EncryptionPanel } from "./encryption-panel";

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
  legacy_seed_only: boolean;
}

/** 멤버 목록 + 활성 토큰의 마지막 수신 시각(수집 연결 상태 확인용) */
async function listMembers(): Promise<MemberRow[]> {
  const r = await getPool().query<MemberRow>(
    `SELECT u.id, u.email, u.name, u.role, u.team_id, u.created_at, t.last_used_at,
            u.team_id IS NOT NULL
              AND EXISTS(SELECT 1 FROM user_team_assignments WHERE user_id = u.id)
              AND NOT EXISTS(
                SELECT 1 FROM user_team_assignments
                 WHERE user_id = u.id AND assignment_kind <> 'legacy_seed'
              ) AS legacy_seed_only
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
      {/* 대시보드와 같은 한 줄 상단 문법 — 작은 제목 + 탭 */}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h1 className="text-sm font-medium">{t("title")}</h1>
        <LinkTabs
          active={tab}
          tabs={[
            { value: "members", label: t("tabs.members"), href: "/admin?tab=members" },
            { value: "teams", label: t("tabs.teams"), href: "/admin?tab=teams" },
            { value: "invites", label: t("tabs.invites"), href: "/admin?tab=invites" },
            { value: "system", label: t("tabs.system"), href: "/admin?tab=system" },
          ]}
        />
      </div>

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
  const attributionStatus = await getTeamAttributionStatus(members.map((member) => member.id));
  const storage = getStorage();
  const legacyPreviews = new Map(
    (await Promise.all(members.map(async (member) => {
      if (!member.legacy_seed_only || attributionStatus.has(member.id)) return null;
      const preview = await storage.previewUnassignedTeamAttribution({
        userId: member.id,
        from: null,
        to: null,
      });
      if (preview.events === 0) return null;
      return [member.id, {
        events: preview.events,
        from: preview.from?.toISOString() ?? null,
        to: preview.to?.toISOString() ?? null,
        totalTokens: preview.totalTokens,
        costUsd: preview.costUsd,
      }] as const;
    }))).filter((entry) => entry !== null),
  );
  const serverVersion = getServerVersion();
  // 멤버 행에는 그 멤버 기기들 중 가장 뒤처진 버전을 표시 (기기별 상세는 본인 설정 화면)
  const worst = worstShimByUser(shimRows);
  const outdatedDevices = shimRows.filter((r) =>
    isShimOutdated(r.shimVersion, serverVersion),
  ).length;

  return (
    <div className="space-y-4">
      {outdatedDevices > 0 ? (
        <Alert className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <span>{t("members.outdatedBanner", { count: outdatedDevices })}</span>
        </Alert>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("members.cardTitle", { count: members.length })}</CardTitle>
          <CardDescription>{t("members.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
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
                const role = m.role === "admin" ? "admin" : "member";
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.name ?? m.email}</div>
                      {m.name ? <div className="text-muted-foreground text-xs">{m.email}</div> : null}
                    </TableCell>
                    <TableCell>
                      <RoleSelect userId={m.id} current={role} />
                    </TableCell>
                    <TableCell>
                      <TeamSelect
                        userId={m.id}
                        current={m.team_id}
                        teams={deptOptions}
                        status={attributionStatus.get(m.id)}
                        legacyPreview={legacyPreviews.get(m.id)}
                      />
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
    <div className="space-y-4">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("teams.cardTitle", { count: teams.length })}</CardTitle>
          <CardDescription>{t("teams.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <TeamPanel teams={teams} />
        </CardContent>
      </Card>
    </div>
  );
}

async function SystemTab() {
  const [pricing, serverUpdate, rollupStatus, legacyRetirement, encryptionStatus, t] = await Promise.all([
    getPricingAdminStatus(),
    getServerUpdateStatus(),
    getRollupAdminStatus().catch(() => null),
    getLegacyRetirementStatus().catch(() => null),
    getEncryptionAdminStatus().catch(() => null),
    getTranslations("admin"),
  ]);
  const contentEnabled = contentCollectionEnabled();
  const legacyKeyRemoved = legacyRetirement?.state === "retired"
    || legacyRetirement?.state === "key_removed_unconfirmed";
  const serverVersion = getServerVersion();

  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 divide-y">
        <SettingsRow wide label={t("system.serverVersion")} description={t("system.serverDescription")}>
          <ServerUpdatePanel currentVersion={serverVersion} initialStatus={serverUpdate} />
        </SettingsRow>

        <SettingsRow wide label={t("system.pricingTitle")} description={t("system.pricingDescription")}>
          <PricingSyncPanel
            initialStatus={pricing}
            builtinScheduler={schedulerEligible(process.env)}
          />
        </SettingsRow>

        <SettingsRow
          wide
          label={t("encryption.title")}
          description={t("encryption.description")}
        >
          <EncryptionPanel status={encryptionStatus} />
        </SettingsRow>

        <SettingsRow
          wide
          label={t("system.legacyRetirementTitle")}
          description={t("system.legacyRetirementDescription")}
        >
          <LegacyRetirementPanel initialStatus={legacyRetirement} />
        </SettingsRow>

        <SettingsRow
          wide
          label={t("system.rollupTitle")}
          description={t("system.rollupDescription")}
        >
          <RollupStatusPanel initialStatus={rollupStatus} />
        </SettingsRow>

        <SettingsRow
          wide
          label={
            <span className="flex items-center gap-2">
              {t("system.contentTitle")}
              {contentEnabled ? (
                <Badge variant="secondary">{t("system.contentBadgeOn")}</Badge>
              ) : (
                <Badge variant="outline">{t("system.contentBadgeOff")}</Badge>
              )}
            </span>
          }
          description={t("system.contentDescription")}
        >
          <div className="space-y-3 text-sm">
            {contentEnabled ? (
              <p className="text-muted-foreground">
                {t.rich("system.contentEnabledBody", { code: (chunks) => <code>{chunks}</code> })}
              </p>
            ) : legacyKeyRemoved ? (
              <p className="text-muted-foreground">{t("system.contentRetiredBody")}</p>
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
          </div>
        </SettingsRow>
      </CardContent>
    </Card>
  );
}

async function InvitesTab() {
  const [baseUrl, pending, teams, t] = await Promise.all([
    getPublicBaseUrl(),
    listPendingInvites(),
    listTeams(),
    getTranslations("admin"),
  ]);

  return (
    <div className="space-y-4">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{t("invites.cardTitle")}</CardTitle>
          <CardDescription>{t("invites.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <InvitePanel
            baseUrl={baseUrl}
            pending={pending.map((p) => ({
              email: p.email,
              role: p.role,
              teamName: p.teamName,
              expiresAt: p.expiresAt.toISOString(),
            }))}
            teams={teams.map((team) => ({ id: team.id, name: team.name }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
