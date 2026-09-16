import { woningIdKey, type WoningId } from "../state/knownWoningen.js";
import type { NormalizedWoning } from "../woningen/types.js";

export interface DetectionResult {
  current: NormalizedWoning[];
  newWoningen: NormalizedWoning[];
  updatedKnownIds: WoningId[];
}

export function detectNewWoningen(
  woningen: NormalizedWoning[],
  knownIds: WoningId[],
): DetectionResult {
  const currentById = new Map<string, NormalizedWoning>();
  for (const woning of woningen) {
    const key = woningIdKey(woning.id);
    if (!currentById.has(key)) {
      currentById.set(key, woning);
    }
  }

  const knownById = new Map(knownIds.map((id) => [woningIdKey(id), id]));
  const newWoningen = [...currentById.values()].filter(
    (woning) => !knownById.has(woningIdKey(woning.id)),
  );
  for (const woning of newWoningen) {
    knownById.set(woningIdKey(woning.id), woning.id);
  }

  return {
    current: [...currentById.values()],
    newWoningen,
    updatedKnownIds: [...knownById.values()],
  };
}
