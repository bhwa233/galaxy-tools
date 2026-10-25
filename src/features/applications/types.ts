export interface CustomApplicationEntry {
  id: string;
  title: string;
  path: string;
  args: string[];
  cwd: string;
}
export interface CustomApplicationsSettings {
  entries: CustomApplicationEntry[];
}
