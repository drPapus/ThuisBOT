export interface RawCity {
  id?: unknown;
  name?: unknown;
  gemeenteId?: unknown;
}

export interface RawWoning {
  id?: unknown;
  urlKey?: unknown;
  street?: unknown;
  houseNumber?: unknown;
  houseNumberAddition?: unknown;
  city?: RawCity | null;
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
  houseNumberAddition?: string;
  city?: string;
  publicationDate?: string;
  closingDate?: string;
  toewijzingID?: string | number;
  modelCode?: string;
  loggedIn: boolean;
  isPassend: boolean;
  kanReageren: boolean;
}
