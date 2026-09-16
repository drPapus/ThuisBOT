export interface RawWoning {
  id?: unknown;
  urlKey?: unknown;
  street?: unknown;
  houseNumber?: unknown;
  city?: unknown;
  publicationDate?: unknown;
  closingDate?: unknown;
  toewijzingID?: unknown;
  toewijzingModelCategorie?: { code?: unknown } | null;
  reactionData?: {
    loggedin?: unknown;
    isPassend?: unknown;
    kanReageren?: unknown;
    zoekprofielMatch?: unknown;
  } | null;
  [key: string]: unknown;
}

export interface NormalizedWoning {
  id: string | number;
  urlKey?: string;
  street?: string;
  houseNumber?: string;
  city?: string;
  publicationDate?: string;
  closingDate?: string;
  toewijzingID?: string | number;
  modelCode?: string;
  isPassend: boolean;
  kanReageren: boolean;
}
