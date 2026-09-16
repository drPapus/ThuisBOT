import type { NormalizedWoning } from "./types.js";

export function isEligible(woning: NormalizedWoning): boolean {
  return woning.isPassend === true && woning.kanReageren === true;
}

export function filterEligible(woningen: NormalizedWoning[]): NormalizedWoning[] {
  return woningen.filter(isEligible);
}
