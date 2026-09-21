import { reportNewWoningen } from "../dry-run/reporter.js";
import { isEligible } from "../woningen/filter.js";
import type { NormalizedWoning } from "../woningen/types.js";

export async function processNewWoningen(
  woningen: NormalizedWoning[],
  firstDetectedAt: string,
  onEligible: (woning: NormalizedWoning) => Promise<void>,
): Promise<void> {
  reportNewWoningen(woningen, firstDetectedAt);
  for (const woning of woningen) {
    if (isEligible(woning)) await onEligible(woning);
  }
}
