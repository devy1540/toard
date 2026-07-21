"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { assignUserRoleWithPool } from "@/lib/admin-members";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";
import { getStorage } from "@/lib/storage";
import { changeUserTeam, TeamMembershipError } from "@/lib/team-membership";

export type TeamState = { error?: string; ok?: boolean };
export type TeamAttributionPreviewDto = {
  events: number;
  from: string | null;
  to: string | null;
  totalTokens: number;
  costUsd: number;
};
export type TeamAssignmentPreviewState = {
  error?: string;
  requiresConfirmation: boolean;
  teamName?: string;
  preview?: TeamAttributionPreviewDto;
};

function previewDto(preview: Awaited<ReturnType<ReturnType<typeof getStorage>["previewUnassignedTeamAttribution"]>>): TeamAttributionPreviewDto {
  return {
    events: preview.events,
    from: preview.from?.toISOString() ?? null,
    to: preview.to?.toISOString() ?? null,
    totalTokens: preview.totalTokens,
    costUsd: preview.costUsd,
  };
}

async function requireAdmin(): Promise<TeamState | null> {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") {
    const t = await getTranslations("admin");
    return { error: t("errors.onlyAdmin") };
  }
  return null;
}

/** 팀 생성 — 공백·중복 이름 거부. */
export async function createTeamAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const t = await getTranslations("admin");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: t("errors.teamNameRequired") };
  if (name.length > 50) return { error: t("errors.teamNameTooLong") };

  const dup = await getPool().query("SELECT 1 FROM teams WHERE name = $1", [name]);
  if ((dup.rowCount ?? 0) > 0) return { error: t("errors.teamNameExists") };

  await getPool().query("INSERT INTO teams (name) VALUES ($1)", [name]);
  revalidatePath("/admin");
  return { ok: true };
}

/** 팀 삭제 — 소속 멤버 0명 + 귀속 이벤트 0건일 때만 (usage_events FK 가 이력을 보호). */
export async function deleteTeamAction(id: string): Promise<TeamState> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const t = await getTranslations("admin");
  const r = await getPool().query<{ members: string; has_events: boolean; has_assignments: boolean }>(
    `SELECT (SELECT count(*) FROM users WHERE team_id = $1) AS members,
            EXISTS(SELECT 1 FROM usage_events WHERE team_id = $1) AS has_events,
            EXISTS(SELECT 1 FROM user_team_assignments WHERE team_id = $1) AS has_assignments`,
    [id],
  );
  const members = Number(r.rows[0]?.members ?? 0);
  if (members > 0) return { error: t("errors.teamHasMembers") };
  if (r.rows[0]?.has_events || r.rows[0]?.has_assignments) return { error: t("errors.teamHasEvents") };

  await getPool().query("DELETE FROM teams WHERE id = $1", [id]);
  revalidatePath("/admin");
  return { ok: true };
}

/** 멤버 팀 배정/해제 — 최초 배정만 미배정 이력을 소급하고 이후 변경은 시점 귀속. */
export async function assignTeamAction(
  userId: string,
  teamId: string | null,
): Promise<TeamState> {
  const me = await getSessionUser();
  const t = await getTranslations("admin");
  if (!me || me.role !== "admin") return { error: t("errors.onlyAdmin") };
  try {
    await changeUserTeam(getPool(), { userId, teamId, actorId: me.id });
  } catch (error) {
    if (error instanceof TeamMembershipError) {
      if (error.code === "TEAM_NOT_FOUND") return { error: t("errors.teamNotFound") };
      if (error.code === "USER_NOT_FOUND") return { error: t("errors.userNotFound") };
    }
    throw error;
  }
  revalidatePath("/admin");
  revalidatePath("/org");
  revalidatePath("/org/teams");
  revalidatePath("/org/team");
  return { ok: true };
}

/** 도구 팀 기본 배포 권한 — 팀 소속 사용자만 leader가 될 수 있다. */
export async function assignTeamRoleAction(userId: string, teamRole: string): Promise<TeamState> {
  const guard = await requireAdmin();
  if (guard) return guard;
  const t = await getTranslations("admin");
  if (teamRole !== "member" && teamRole !== "leader") return { error: t("errors.teamRoleInvalid") };
  const actor = await getSessionUser();
  if (!actor) return { error: t("errors.onlyAdmin") };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{ team_id: string | null; team_role: string }>(
      "SELECT team_id, team_role FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const row = target.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { error: t("errors.userNotFound") };
    }
    if (teamRole === "leader" && !row.team_id) {
      await client.query("ROLLBACK");
      return { error: t("errors.teamRequiredForLeader") };
    }
    await client.query("UPDATE users SET team_role = $2 WHERE id = $1", [userId, teamRole]);
    await client.query(
      `INSERT INTO tool_deployment_audit (actor_user_id, action, team_id, before_value, after_value)
       VALUES ($1, 'team_leader_changed', $2, $3::jsonb, $4::jsonb)`,
      [actor.id, row.team_id, JSON.stringify({ userId, teamRole: row.team_role }), JSON.stringify({ userId, teamRole })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/admin");
  return { ok: true };
}

/** 최초 팀 배정일 때만 기존 미배정 사용량의 예상 소급 범위를 반환한다. */
export async function previewTeamAssignmentAction(
  userId: string,
  teamId: string,
): Promise<TeamAssignmentPreviewState> {
  const me = await getSessionUser();
  const t = await getTranslations("admin");
  if (!me || me.role !== "admin") {
    return { error: t("errors.onlyAdmin"), requiresConfirmation: false };
  }
  const [userResult, teamResult] = await Promise.all([
    getPool().query<{ team_id: string | null; has_history: boolean }>(
      `SELECT team_id::text,
              EXISTS(SELECT 1 FROM user_team_assignments WHERE user_id = users.id) AS has_history
         FROM users
        WHERE id = $1`,
      [userId],
    ),
    getPool().query<{ name: string }>("SELECT name FROM teams WHERE id = $1", [teamId]),
  ]);
  const user = userResult.rows[0];
  const team = teamResult.rows[0];
  if (!user) return { error: t("errors.userNotFound"), requiresConfirmation: false };
  if (!team) return { error: t("errors.teamNotFound"), requiresConfirmation: false };
  if (user.team_id !== null || user.has_history) {
    return { requiresConfirmation: false, teamName: team.name };
  }
  const preview = await getStorage().previewUnassignedTeamAttribution({
    userId,
    from: null,
    to: null,
  });
  return {
    requiresConfirmation: preview.events > 0,
    teamName: team.name,
    preview: previewDto(preview),
  };
}

/** 기존 설치의 legacy seed 사용자가 명시적으로 확인한 경우에만 미배정 이력 귀속 job을 만든다. */
export async function requestLegacyTeamAttributionAction(userId: string): Promise<TeamState> {
  const me = await getSessionUser();
  const t = await getTranslations("admin");
  if (!me || me.role !== "admin") return { error: t("errors.onlyAdmin") };

  const eligibility = await getPool().query<{
    team_id: string | null;
    assignment_id: string | null;
    legacy_only: boolean;
  }>(
    `SELECT users.team_id::text,
            current_assignment.id::text AS assignment_id,
            EXISTS(SELECT 1 FROM user_team_assignments WHERE user_id = users.id)
              AND NOT EXISTS(
                SELECT 1 FROM user_team_assignments
                 WHERE user_id = users.id AND assignment_kind <> 'legacy_seed'
              ) AS legacy_only
       FROM users
       LEFT JOIN LATERAL (
         SELECT id
           FROM user_team_assignments
          WHERE user_id = users.id
            AND team_id = users.team_id
            AND effective_to IS NULL
          ORDER BY effective_from DESC
          LIMIT 1
       ) AS current_assignment ON true
      WHERE users.id = $1`,
    [userId],
  );
  const candidate = eligibility.rows[0];
  if (!candidate) return { error: t("errors.userNotFound") };
  if (!candidate.team_id || !candidate.assignment_id || !candidate.legacy_only) {
    return { error: t("errors.legacyAttributionNotEligible") };
  }

  const preview = await getStorage().previewUnassignedTeamAttribution({
    userId,
    from: null,
    to: null,
  });
  if (preview.events === 0) return { ok: true };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1540))", [userId]);
    const locked = await client.query<{
      team_id: string;
      assignment_id: string;
      effective_from: Date | string;
      effective_to: Date | null;
      legacy_only: boolean;
    }>(
      `SELECT users.team_id::text,
              assignment.id::text AS assignment_id,
              assignment.effective_from,
              assignment.effective_to,
              NOT EXISTS(
                SELECT 1 FROM user_team_assignments history
                 WHERE history.user_id = users.id
                   AND history.assignment_kind <> 'legacy_seed'
              ) AS legacy_only
         FROM users
         JOIN user_team_assignments assignment
           ON assignment.user_id = users.id
          AND assignment.team_id = users.team_id
          AND assignment.effective_to IS NULL
        WHERE users.id = $1
        FOR UPDATE OF users, assignment`,
      [userId],
    );
    const row = locked.rows[0];
    if (
      !row
      || !row.legacy_only
      || row.team_id !== candidate.team_id
      || row.assignment_id !== candidate.assignment_id
    ) {
      await client.query("ROLLBACK");
      return { error: t("errors.legacyAttributionNotEligible") };
    }
    await client.query(
      `INSERT INTO team_attribution_jobs
         (assignment_id, user_id, team_id, kind, status, from_ts, to_ts, matched_events)
       VALUES ($1, $2, $3, 'legacy_adoption', 'pending', $4, $5, $6)
       ON CONFLICT (assignment_id, kind) DO UPDATE
         SET matched_events = GREATEST(team_attribution_jobs.matched_events, EXCLUDED.matched_events),
             updated_at = now()`,
      [row.assignment_id, userId, row.team_id, row.effective_from, row.effective_to, preview.events],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/admin");
  return { ok: true };
}

/** 멤버 역할 변경 — 마지막 admin 은 보호해 관리 화면 접근 불능 상태를 막는다. */
export async function assignRoleAction(userId: string, role: string): Promise<TeamState> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const t = await getTranslations("admin");
  const result = await assignUserRoleWithPool(getPool(), userId, role);
  if (!result.ok) {
    if (result.reason === "invalid-role") return { error: t("errors.roleInvalid") };
    if (result.reason === "user-not-found") return { error: t("errors.userNotFound") };
    return { error: t("errors.lastAdminRequired") };
  }

  revalidatePath("/admin");
  return { ok: true };
}
