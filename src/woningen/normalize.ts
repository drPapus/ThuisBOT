import type { NormalizedWoning, RawWoning } from "./types.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function identifier(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export function normalizeWoning(raw: RawWoning, index: number): NormalizedWoning {
  const id = identifier(raw.id);
  if (id === undefined) {
    throw new Error(`Housing item at index ${index} has no valid id.`);
  }

  const optional = {
    urlKey: stringValue(raw.urlKey),
    street: stringValue(raw.street),
    houseNumber: stringValue(raw.houseNumber),
    city: stringValue(raw.city),
    publicationDate: stringValue(raw.publicationDate),
    closingDate: stringValue(raw.closingDate),
    toewijzingID: identifier(raw.toewijzingID),
    modelCode: stringValue(raw.toewijzingModelCategorie?.code),
  };

  return {
    id,
    ...(optional.urlKey !== undefined && { urlKey: optional.urlKey }),
    ...(optional.street !== undefined && { street: optional.street }),
    ...(optional.houseNumber !== undefined && { houseNumber: optional.houseNumber }),
    ...(optional.city !== undefined && { city: optional.city }),
    ...(optional.publicationDate !== undefined && { publicationDate: optional.publicationDate }),
    ...(optional.closingDate !== undefined && { closingDate: optional.closingDate }),
    ...(optional.toewijzingID !== undefined && { toewijzingID: optional.toewijzingID }),
    ...(optional.modelCode !== undefined && { modelCode: optional.modelCode }),
    isPassend: raw.reactionData?.isPassend === true,
    kanReageren: raw.reactionData?.kanReageren === true,
  };
}

export function normalizeWoningen(raw: RawWoning[]): NormalizedWoning[] {
  return raw.map(normalizeWoning);
}
