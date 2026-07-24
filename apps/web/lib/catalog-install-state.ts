import type { CatalogInstallState } from "@toard/core";

export type CatalogInstallStateMessageKey =
  | "state.not_installed"
  | "state.unavailable"
  | "state.sameVersion"
  | "state.differentVersion"
  | "state.versionUnknown";

export function catalogInstallStateMessageKey(
  state: CatalogInstallState,
): CatalogInstallStateMessageKey {
  if (state.status === "not_installed" || state.status === "unavailable") {
    return `state.${state.status}`;
  }
  if (state.versionRelation === "same") return "state.sameVersion";
  if (state.versionRelation === "different") return "state.differentVersion";
  return "state.versionUnknown";
}
