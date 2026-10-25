import { invoke, open } from "../../platform/desktop";
import type { CustomApplicationEntry, CustomApplicationsSettings } from "./types";

export function getCustomApplications(): Promise<CustomApplicationsSettings> {
  return invoke("applications_entries_get");
}
export function saveCustomApplications(
  entries: CustomApplicationEntry[],
): Promise<CustomApplicationsSettings> {
  return invoke("applications_entries_save", { entries });
}
export async function pickCustomApplication(title: string): Promise<string | undefined> {
  const value = await open({
    title,
    filters: [{ name: title, extensions: ["exe", "lnk", "url"] }],
  });
  return typeof value === "string" ? value : undefined;
}
export async function pickApplicationDirectory(title: string): Promise<string | undefined> {
  const value = await open({ title, directory: true });
  return typeof value === "string" ? value : undefined;
}
