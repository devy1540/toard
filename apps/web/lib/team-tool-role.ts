export type TeamRole = "member" | "leader";
export type TeamRoleTarget = { userId: string; teamId: string | null; teamRole: TeamRole };
export type TeamRoleDependencies = {
  getTarget(userId: string): Promise<TeamRoleTarget | null>;
  save(input: TeamRoleTarget & { actorUserId: string }): Promise<void>;
};

export async function changeTeamRole(
  actor: { id: string; role: string },
  input: { userId: string; teamRole: TeamRole },
  dependencies: TeamRoleDependencies,
): Promise<{ ok: true } | { ok: false; reason: "forbidden" | "not-found" | "team-required" }> {
  if (actor.role !== "admin") return { ok: false, reason: "forbidden" };
  const target = await dependencies.getTarget(input.userId);
  if (!target) return { ok: false, reason: "not-found" };
  if (input.teamRole === "leader" && !target.teamId) return { ok: false, reason: "team-required" };
  await dependencies.save({ ...target, actorUserId: actor.id, teamRole: input.teamRole });
  return { ok: true };
}
