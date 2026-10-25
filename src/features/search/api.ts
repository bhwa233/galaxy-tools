import { invoke } from "../../platform/desktop";
import type { SearchScopeSettings, SearchServiceStatus } from "./types";

export function getSearchScope(): Promise<SearchScopeSettings> {
  return invoke("search_scope_get");
}
export function saveSearchScope(
  excludedRoots: string[],
  policy?: Omit<SearchScopeSettings, "excludedRoots">,
): Promise<SearchScopeSettings> {
  return invoke("search_scope_save", { excludedRoots, ...policy });
}
export function getSearchServiceStatus(): Promise<SearchServiceStatus> {
  return invoke("search_service_status");
}
export function configureSearchService(
  excludedRoots: string[],
  volumeEnabled: { id: string; enabled: boolean }[],
): Promise<SearchServiceStatus> {
  return invoke("search_service_configure", { excludedRoots, volumeEnabled });
}
export function rebuildSearchService(): Promise<SearchServiceStatus> {
  return invoke("search_service_rebuild");
}
export function pickSearchScopeDirectory(): Promise<string | undefined> {
  return invoke("search_scope_pick");
}
