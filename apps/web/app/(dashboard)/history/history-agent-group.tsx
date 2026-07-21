import { CheckCircle2, GitBranch, Sparkles } from "lucide-react";
import { ProviderIcon } from "@/components/dashboard/provider-icon";
import { TurnText } from "@/components/dashboard/turn-text";
import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { costCoverageForStatus, formatCostForCoverage } from "@/lib/cost-coverage";
import { fmtCompact, fmtUsd } from "@/lib/format";
import type { HistoryAgentRun, TurnUsage } from "@/lib/history-grouping";

export function HistoryAgentGroup({
  agents,
  firstTs,
  latestTs,
  turnUsage,
  fmtTime,
  labels,
  costLabels,
  idPrefix,
}: {
  agents: HistoryAgentRun[];
  firstTs: Date;
  latestTs: Date;
  turnUsage: Map<string, TurnUsage>;
  fmtTime: (date: Date) => string;
  labels: {
    subagents: (count: number) => string;
    subagent: string;
    parallelExecution: string;
    completed: string;
    fallbackName: (index: number) => string;
    depth: (depth: number) => string;
    assigned: string;
    turns: (count: number) => string;
    rolePrompt: string;
    roleResponse: string;
    showMore: string;
    showLess: string;
    contentUnavailable: string;
  };
  costLabels: { partial: string; unpriced: string; legacy: string };
  idPrefix: string;
}) {
  return (
    <section className="ml-0 space-y-2 border-l pl-3 sm:ml-9 sm:pl-4" aria-label={labels.subagents(agents.length)}>
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <GitBranch className="size-3.5" />
          {labels.subagents(agents.length)}
        </span>
        <span>{labels.parallelExecution} · {fmtTime(firstTs)}–{fmtTime(latestTs)}</span>
      </div>

      {agents.map((agent, agentIndex) => (
        <Disclosure
          key={agent.id}
          defaultOpen={agentIndex === 0}
          triggerClassName="w-full min-w-0 justify-between rounded-xl border bg-muted/20 px-3 py-2 text-left hover:bg-muted/40"
          contentClassName="ml-2 border-l pl-3"
          trigger={(
            <span key={`${agent.id}-trigger`} className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px]">{labels.subagent}</Badge>
                <span className="font-medium">{agent.name ?? labels.fallbackName(agentIndex + 1)}</span>
                {agent.role ? <Badge variant="outline" className="text-[11px]">{agent.role}</Badge> : null}
                {agent.depth ? (
                  <span className="text-muted-foreground text-xs">{labels.depth(agent.depth)}</span>
                ) : null}
              </span>
              <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <CheckCircle2 className="size-3 text-emerald-600 dark:text-emerald-400" />
                <span>{labels.completed}</span>
                <span>·</span>
                <span>{labels.turns(agent.turns.length)}</span>
                <span>·</span>
                <span>{fmtTime(agent.firstTs)}–{fmtTime(agent.latestTs)}</span>
              </span>
            </span>
          )}
        >
          <div className="space-y-3 py-3">
            {agent.turns.map((turn, turnIndex) => {
              const isUser = turn.role === "user";
              const usage = turnUsage.get(turn.dedupKey);
              const content = turn.contentUnavailable ? (
                <p className="text-muted-foreground text-sm italic">{labels.contentUnavailable}</p>
              ) : (
                <TurnText
                  id={`${idPrefix}-${agentIndex}-${turnIndex}`}
                  text={turn.text}
                  more={labels.showMore}
                  less={labels.showLess}
                />
              );
              if (isUser) {
                return (
                  <div key={turn.dedupKey} className="flex flex-col items-end">
                    {turnIndex === 0 ? (
                      <span className="text-muted-foreground mb-1 text-[11px]">{labels.assigned}</span>
                    ) : null}
                    <div className="bg-primary/10 max-w-[90%] rounded-2xl rounded-br-md px-3.5 py-2.5">
                      <span className="sr-only">{labels.rolePrompt}</span>
                      {content}
                    </div>
                    <span className="text-muted-foreground mt-1 text-[11px] tabular-nums">{fmtTime(turn.ts)}</span>
                  </div>
                );
              }
              return (
                <div key={turn.dedupKey} className="flex max-w-[96%] gap-2.5">
                  <div className="bg-muted text-muted-foreground mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border">
                    <ProviderIcon
                      providerKey={turn.providerKey}
                      className="size-3.5"
                      fallback={<Sparkles className="size-3.5" />}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="bg-muted/40 rounded-2xl rounded-tl-md border px-3.5 py-2.5">
                      <span className="sr-only">{labels.roleResponse}</span>
                      {content}
                    </div>
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                      {usage ? (
                        <span className="font-mono">
                          {usage.model ? `${usage.model} · ` : ""}↑{fmtCompact(usage.inputTokens)}{" "}
                          ↓{fmtCompact(usage.outputTokens)} ·{" "}
                          {formatCostForCoverage(
                            fmtUsd(usage.costUsd),
                            costCoverageForStatus(usage.costStatus),
                            costLabels,
                          )}
                        </span>
                      ) : null}
                      <span className="tabular-nums">{fmtTime(turn.ts)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Disclosure>
      ))}
    </section>
  );
}
