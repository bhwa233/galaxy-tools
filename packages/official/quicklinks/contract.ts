export interface QuickLink {
  id: string;
  title: string;
  keyword: string;
  kind: "url" | "program";
  target: string;
  args: string[];
  cwd: string;
  enabled: boolean;
  description: string;
}

export interface QuickLinksState {
  revision: string;
  entries: QuickLink[];
  presets: QuickLink[];
}

export interface QuickLinkInput {
  id: string;
  entryRevision?: string;
  query?: string;
  values?: Record<string, string>;
}

export type QuickLinkResolution =
  | {
      kind: "prompt";
      entry: QuickLink;
      entryRevision: string;
      query: string;
      fields: string[];
      values: Record<string, string>;
    }
  | { kind: "url"; url: string }
  | { kind: "program"; path: string; args: string[]; cwd: string };
