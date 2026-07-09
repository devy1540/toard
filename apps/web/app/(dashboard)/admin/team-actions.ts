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

  await getPool().query("UPDATE users SET team_id = $2 WHERE id = $1", [userId, teamId]);
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
