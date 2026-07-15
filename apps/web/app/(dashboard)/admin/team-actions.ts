"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { assignUserRoleWithPool } from "@/lib/admin-members";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session-user";

export type TeamState = { error?: string; ok?: boolean };

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
  const r = await getPool().query<{ members: string; has_events: boolean }>(
    `SELECT (SELECT count(*) FROM users WHERE team_id = $1) AS members,
            EXISTS(SELECT 1 FROM usage_events WHERE team_id = $1) AS has_events`,
    [id],
  );
  const members = Number(r.rows[0]?.members ?? 0);
  if (members > 0) return { error: t("errors.teamHasMembers") };
  if (r.rows[0]?.has_events) return { error: t("errors.teamHasEvents") };

  await getPool().query("DELETE FROM teams WHERE id = $1", [id]);
  revalidatePath("/admin");
  return { ok: true };
}

/** 멤버 팀 배정/해제 — 이후 수집분부터 반영(이벤트는 수집 시점 귀속, §4.3). */
export async function assignTeamAction(
  userId: string,
  teamId: string | null,
): Promise<TeamState> {
  const guard = await requireAdmin();
  if (guard) return guard;

  await getPool().query(
    "UPDATE users SET team_id = $2, team_role = CASE WHEN $2 IS NULL THEN 'member' ELSE team_role END WHERE id = $1",
    [userId, teamId],
  );
  revalidatePath("/admin");
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
    await client.query("ROLLBACK");
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
