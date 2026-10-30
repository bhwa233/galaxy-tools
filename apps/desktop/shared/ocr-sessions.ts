export interface OcrDocument {
  text: string;
  ranges: Array<{ start: number; end: number } | null>;
}
export interface OcrSession {
  sessionId: string;
  text: string;
  width: number;
  height: number;
  source: { id: string };
  lines: Array<{
    text: string;
    box: number[][];
    characters?: Array<{ text: string; box: number[][] }>;
  }>;
  draft?: OcrDocument;
  createdAt: string;
}
export interface OcrSessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  edited: boolean;
}
