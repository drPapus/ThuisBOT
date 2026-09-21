import type { CoordinatedAutomaticResult } from "../reaction/automaticCoordinator.js";
import { isEligible } from "../woningen/filter.js";
import type { NormalizedWoning } from "../woningen/types.js";

export interface AutoReactOnceDependencies {
  fetchCurrentAanbod(): Promise<NormalizedWoning[]>;
  coordinate(woning: NormalizedWoning): Promise<CoordinatedAutomaticResult>;
}

export function parseAutoReactOnceArgs(args: string[]): string {
  if (args.length !== 1 || !/^\d+$/.test(args[0] ?? "")) {
    throw new Error("Usage: npm run auto-react-once -- <dwellingId>");
  }
  return args[0]!;
}

export async function runAutoReactOnceSelection(
  dwellingId: string,
  dependencies: AutoReactOnceDependencies,
): Promise<CoordinatedAutomaticResult> {
  const aanbod = await dependencies.fetchCurrentAanbod();
  const selected = aanbod.find((woning) => String(woning.id) === dwellingId);
  if (!selected) throw new Error(`Dwelling ${dwellingId} is not present in current Actueel aanbod.`);
  if (selected.loggedIn !== true) throw new Error("SESSION/API PROFILE NOT AUTHENTICATED");
  if (!isEligible(selected)) {
    throw new Error(`Dwelling ${dwellingId} is not currently eligible and reactable.`);
  }
  return dependencies.coordinate(selected);
}
