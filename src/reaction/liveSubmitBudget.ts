export const MAX_LIVE_SUBMITS_PER_PROCESS = 1 as const;

export interface LiveSubmitBudget {
  readonly used: number;
  consume(attemptId: string): void;
}

export function createLiveSubmitBudget(): LiveSubmitBudget {
  let used = 0;
  const consumedAttemptIds = new Set<string>();
  return {
    get used() { return used; },
    consume(attemptId: string): void {
      if (consumedAttemptIds.has(attemptId)) {
        throw new Error("LIVE_SUBMIT_ATTEMPT_ID_ALREADY_CONSUMED");
      }
      if (used >= MAX_LIVE_SUBMITS_PER_PROCESS) throw new Error("LIVE_SUBMIT_PROCESS_BUDGET_EXHAUSTED");
      consumedAttemptIds.add(attemptId);
      used += 1;
    },
  };
}

export const processLiveSubmitBudget = createLiveSubmitBudget();
