import { invoke } from "../../platform/desktop";
import type {
  CustomApplicationEntry,
  CustomApplicationsSettings,
  CustomApplicationTarget,
} from "./types";

export function getCustomApplications(): Promise<CustomApplicationsSettings> {
  return invoke("applications_entries_get");
}
export function saveCustomApplications(
  entries: CustomApplicationEntry[],
  revision: string,
): Promise<CustomApplicationsSettings> {
  return invoke("applications_entries_save", { entries, revision });
}
export function pickCustomApplication(
  directory = false,
): Promise<CustomApplicationTarget | undefined> {
  return invoke("applications_entries_pick", {
    purpose: "target",
    ...(directory ? { directory: true } : {}),
  });
}
export async function pickApplicationDirectory(): Promise<string | undefined> {
  const value = await invoke("applications_entries_pick", {
    purpose: "cwd",
    directory: true,
  });
  return value?.path;
}
