import { reportNewWoningen } from "../dry-run/reporter.js";
import { isEligible } from "../woningen/filter.js";
import type { NormalizedWoning } from "../woningen/types.js";
import type { AutomaticProcessingOutcome } from "../reaction/automaticCoordinator.js";

export async function processNewWoningen(
  woningen: NormalizedWoning[],
  firstDetectedAt: string,
  onEligible: (woning: NormalizedWoning) => Promise<AutomaticProcessingOutcome>,
): Promise<AutomaticProcessingOutcome[]> {
  reportNewWoningen(woningen, firstDetectedAt);
  const outcomes: AutomaticProcessingOutcome[] = [];
  for (const woning of woningen) {
    if (isEligible(woning)) outcomes.push(await onEligible(woning));
  }
  return outcomes;
}
