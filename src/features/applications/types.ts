export type CustomApplicationKind = "program" | "shortcut" | "document" | "directory";

export interface CustomApplicationTarget {
  path: string;
  kind: CustomApplicationKind;
}

export interface CustomApplicationEntry {
  id: string;
  title: string;
  path: string;
  args: string[];
  cwd: string;
  kind: CustomApplicationKind;
}
export interface CustomApplicationsSettings {
  revision: string;
  entries: CustomApplicationEntry[];
  supportedKinds?: CustomApplicationKind[];
}
