export type RollupStatusRequestTicket = {
  generation: number;
  signal: AbortSignal;
};

export type RollupStatusRequestGate = {
  begin(): RollupStatusRequestTicket;
  canCommit(ticket: RollupStatusRequestTicket): boolean;
  invalidate(): void;
  dispose(): void;
};

export function createRollupStatusRequestGate(): RollupStatusRequestGate {
  let generation = 0;
  let activeController: AbortController | null = null;
  let disposed = false;

  const invalidate = () => {
    generation++;
    activeController?.abort();
    activeController = null;
  };

  return {
    begin() {
      invalidate();
      const controller = new AbortController();
      activeController = controller;
      if (disposed) controller.abort();
      return { generation, signal: controller.signal };
    },
    canCommit(ticket) {
      return !disposed
        && !ticket.signal.aborted
        && ticket.generation === generation
        && activeController?.signal === ticket.signal;
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
