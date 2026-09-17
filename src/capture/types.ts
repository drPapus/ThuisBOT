export type CapturedBody = unknown;

export interface CaptureRequestRecord {
  kind: "request";
  id: number;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  contentType?: string;
  headers: Record<string, string>;
  body?: CapturedBody;
}

export interface CaptureResponseRecord {
  kind: "response";
  requestId: number;
  timestamp: string;
  url: string;
  status: number;
  contentType?: string;
  headers: Record<string, string>;
  body?: CapturedBody;
}

export type CaptureRecord = CaptureRequestRecord | CaptureResponseRecord;
