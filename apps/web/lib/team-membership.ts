import type { Pool } from "pg";

export type TeamChangeKind =
  | "noop"
  | "initial_assignment"
  | "transfer"
  | "unassignment"
  | "reassignment";

export type TeamChangeResult = {
  changed: boolean;
  kind: TeamChangeKind;
  assignmentId: string | null;
  attributionJobId: string | null;
};

export type TeamMembershipErrorCode =
  | "INVALID_TEAM_CHANGE_TIME"
  | "TEAM_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "TEAM_MEMBERSHIP_INCONSISTENT";

export class TeamMembershipError extends Error {
  constructor(readonly code: TeamMembershipErrorCode) {
    super(code);
    this.name = "TeamMembershipError";
  }
}

type AssignmentRow = {
  id: string;
  team_id: string;
  effective_from: Date;
  effective_to: Date | null;
};

export async function changeUserTeam(
  pool: Pool,
  input: {
    userId: string;
    teamId: string | null;
    actorId: string;
    now?: Date;
    completeOnboarding?: boolean;
  },
): Promise<TeamChangeResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TeamMembershipError("INVALID_TEAM_CHANGE_TIME");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1540))", [input.userId]);
    const userResult = await client.query<{
      id: string;
      team_id: string | null;
      role: string;
      team_onboarding_completed_at: Date | null;
    }>(
      `SELECT id, team_id, role, team_onboarding_completed_at
       FROM users WHERE id = $1 FOR UPDATE`,
      [input.userId],
    );
    const user = userResult.rows[0];
    if (!user) throw new TeamMembershipError("USER_NOT_FOUND");
    if (
      input.completeOnboarding
      && (user.role !== "member" || user.team_id != null || user.team_onboarding_completed_at != null)
    ) {
      await client.query("COMMIT");
      return { changed: false, kind: "noop", assignmentId: null, attributionJobId: null };
    }
    if (user.team_id === input.teamId) {
      await client.query("COMMIT");
      return { changed: false, kind: "noop", assignmentId: null, attributionJobId: null };
    }

    if (input.teamId) {
      const team = await client.query("SELECT 1 FROM teams WHERE id = $1", [input.teamId]);
      if ((team.rowCount ?? 0) === 0) throw new TeamMembershipError("TEAM_NOT_FOUND");
    }

    const assignmentsResult = await client.query<AssignmentRow>(
      `SELECT id, team_id, effective_from, effective_to
       FROM user_team_assignments
       WHERE user_id = $1
       ORDER BY effective_from
       FOR UPDATE`,
      [input.userId],
    );
    const assignments = assignmentsResult.rows;
    const open = assignments.find((assignment) => assignment.effective_to == null);
    if ((user.team_id == null) !== (open == null) || (open && open.team_id !== user.team_id)) {
      throw new TeamMembershipError("TEAM_MEMBERSHIP_INCONSISTENT");
    }

    const initial = user.team_id == null && input.teamId != null && assignments.length === 0;
    const kind: TeamChangeKind = initial
      ? "initial_assignment"
      : user.team_id != null && input.teamId != null
        ? "transfer"
        : user.team_id != null
          ? "unassignment"
          : "reassignment";

    if (open) {
      await client.query(
        `UPDATE user_team_assignments
         SET effective_to = $2
         WHERE id = $1 AND effective_to IS NULL`,
        [open.id, now],
      );
    }

    let assignmentId: string | null = null;
    if (input.teamId) {
      const assignmentKind = input.completeOnboarding ? "onboarding" : "admin";
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO user_team_assignments
           (user_id, team_id, effective_from, effective_to, assignment_kind, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [input.userId, input.teamId, initial ? "-infinity" : now, null, assignmentKind, input.actorId],
      );
      assignmentId = inserted.rows[0]?.id ?? null;
      if (!assignmentId) throw new TeamMembershipError("TEAM_MEMBERSHIP_INCONSISTENT");
    }

    if (input.completeOnboarding) {
      await client.query(
        `UPDATE users
         SET team_id = $2::uuid,
             team_role = CASE WHEN $2::uuid IS NULL THEN 'member' ELSE team_role END,
             team_onboarding_completed_at = COALESCE(team_onboarding_completed_at, $3)
         WHERE id = $1`,
        [input.userId, input.teamId, now],
      );
    } else {
      await client.query(
        "UPDATE users SET team_id = $2::uuid, team_role = CASE WHEN $2::uuid IS NULL THEN 'member' ELSE team_role END WHERE id = $1",
        [input.userId, input.teamId],
      );
    }

    let attributionJobId: string | null = null;
    if (initial && assignmentId && input.teamId) {
      const job = await client.query<{ id: string }>(
        `INSERT INTO team_attribution_jobs
           (assignment_id, user_id, team_id, kind, from_ts, to_ts)
         VALUES ($1, $2, $3, 'initial_backfill', '-infinity', NULL)
         RETURNING id`,
        [assignmentId, input.userId, input.teamId],
      );
      attributionJobId = job.rows[0]?.id ?? null;
      if (!attributionJobId) throw new TeamMembershipError("TEAM_MEMBERSHIP_INCONSISTENT");
    }

    await client.query("COMMIT");
    return { changed: true, kind, assignmentId, attributionJobId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
