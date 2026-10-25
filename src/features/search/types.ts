export interface SearchScopeSettings {
  excludedRoots: string[];
  extensions: string[];
  maxFileMiB: number;
  includeHidden: boolean;
}
export interface SearchServiceVolume {
  id: string;
  label: string;
  mountPoint: string;
  fileSystem: string;
  online: boolean;
  supported: boolean;
  enabled: boolean;
  indexedItems: number;
  progress: number;
  state: string;
  error: string;
}
export interface SearchServiceStatus {
  status: string;
  message: string;
  connected: boolean;
  volumes: SearchServiceVolume[];
  excludedRoots: string[];
  effectiveExcludedRoots: string[];
}
