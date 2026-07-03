import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { LinkTabs } from "@/components/dashboard/link-tabs";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getPool } from "@/lib/db";
import { listPendingInvites } from "@/lib/invites";
import { getPricingStatus } from "@/lib/pricing";
import { getPublicBaseUrl } from "@/lib/public-url";
import { getSessionUser } from "@/lib/session-user";
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

  return (
    <div className="space-y-6">
      <PageHeader title="관리" description="멤버·팀과 수집 연결 상태를 관리합니다" />

      <LinkTabs
        active={tab}
        tabs={[
          { value: "members", label: "멤버", href: "/admin?tab=members" },
          { value: "teams", label: "팀", href: "/admin?tab=teams" },
          { value: "invites", label: "초대", href: "/admin?tab=invites" },
          { value: "system", label: "시스템", href: "/admin?tab=system" },
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
  const [members, teams] = await Promise.all([listMembers(), listTeams()]);
  const deptOptions = teams.map((d) => ({ id: d.id, name: d.name }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>멤버 ({members.length})</CardTitle>
        <CardDescription>
          팀 변경은 이후 수집분부터 반영됩니다(과거 이벤트는 당시 팀 귀속 유지). 마지막 수신이
          비어 있으면 shim 미설치 또는 수집 미연결 상태입니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>멤버</TableHead>
              <TableHead>역할</TableHead>
              <TableHead>팀</TableHead>
              <TableHead className="text-right">마지막 수신</TableHead>
              <TableHead className="text-right">가입일</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
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
                <TableCell className="text-muted-foreground text-right">{fmtDate(m.last_used_at)}</TableCell>
                <TableCell className="text-muted-foreground text-right">{fmtDate(m.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

async function TeamsTab() {
  const teams = await listTeams();

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>팀 ({teams.length})</CardTitle>
          <CardDescription>
            팀을 만들고 멤버 탭에서 배정하세요. 순위·비교는 전체 현황의 팀 탭에 반영됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TeamPanel teams={teams} />
        </CardContent>
      </Card>
    </div>
  );
}

async function SystemTab() {
  const pricing = await getPricingStatus();

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>가격 동기화</CardTitle>
          <CardDescription>
            LiteLLM 모델 가격을 받아 비용 계산에 사용합니다. 가격이 없으면 비용이 $0 으로
            계산되므로, cron(sync-pricing) 등록과 별개로 여기서 수동 실행할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PricingSyncPanel models={pricing.models} lastDay={pricing.lastDay} />
        </CardContent>
      </Card>
    </div>
  );
}

async function InvitesTab() {
  const [baseUrl, pending] = await Promise.all([getPublicBaseUrl(), listPendingInvites()]);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>멤버 초대</CardTitle>
          <CardDescription>
            초대 링크를 만들어 전달하면, 받은 사람이 비밀번호를 설정해 가입하고 설치까지 이어집니다.
          </CardDescription>
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
