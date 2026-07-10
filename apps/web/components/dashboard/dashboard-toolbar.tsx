import type { ReactNode } from "react";
import { FeatureStatusBadge, type FeatureStatus } from "./feature-status-badge";

type DashboardToolbarProps = {
  title?: string;
  statusBadge?: { status: FeatureStatus; label: string };
  leading?: ReactNode;
  filters: ReactNode;
  trailing?: ReactNode;
  splitHeader?: boolean;
};

export function DashboardToolbar({
  title,
  statusBadge,
  leading,
  filters,
  trailing,
  splitHeader = false,
}: DashboardToolbarProps) {
  const titleNode = title ? (
    <div className="mr-2 flex shrink-0 items-center gap-2">
      <h1 className="text-sm font-medium">{title}</h1>
      {statusBadge ? <FeatureStatusBadge status={statusBadge.status}>{statusBadge.label}</FeatureStatusBadge> : null}
    </div>
  ) : null;
  const trailingNode = trailing ? <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div> : null;

  if (splitHeader) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {titleNode}
          {leading}
          {trailingNode}
        </div>
        <div className="flex flex-wrap items-center gap-2">{filters}</div>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {titleNode}
      {leading}
      {filters}
      {trailingNode}
    </div>
  );
}
