export type ClipboardKind = "text" | "html" | "rtf" | "image" | "files";
export interface ClipboardSettings {
  paused: boolean;
  excludedApps: string[];
  excludedText: string[];
  retentionDays: number | null;
  visibleCount: number | null;
  quickKeys: "digits" | "function";
  quickAction: "copy" | "paste";
  compactPosition: "cursor" | "edge";
}
export interface ClipboardEntry {
  id: string;
  kind: ClipboardKind;
  preview: string;
  text: string;
  files: string[];
  source: string;
  sourceTitle: string;
  formats: string[];
  createdAt: number;
  lastUsedAt: number;
  copies: number;
  note: string;
  tags: string[];
  pinned: boolean;
  favorite: boolean;
  favoritePinned: boolean;
  inHistory: boolean;
  groups: string[];
  thumbnailDataUrl?: string;
  textTruncated?: boolean;
}
export interface ClipboardGroup {
  id: string;
  name: string;
  kind: "gallery" | "favorite";
}
export interface ClipboardEmoji {
  id: string;
  symbol: string;
  name: string;
  group: string;
  lastUsedAt?: number;
}
export interface ClipboardDraft {
  text: string;
  note: string;
  tags: string;
}
export interface ClipboardPage {
  entries: ClipboardEntry[];
  total: number;
  settings: ClipboardSettings;
  groups: ClipboardGroup[];
  statistics: { entries: number; favorites: number; bytes: number; databaseBytes: number };
  nativeStatus?: { running: boolean; error?: string };
}
export type ClipboardRequest =
  | { action: "open-quick" }
  | {
      action: "list";
      query?: string;
      kind?: ClipboardKind;
      view?: "history" | "favorites" | "all";
      groupId?: string;
      limit?: number;
      offset?: number;
    }
  | { action: "detail"; id: string }
  | ({ action: "draft.save"; id: string } & ClipboardDraft)
  | { action: "draft.remove"; id: string }
  | { action: "copy" | "paste"; id: string; mode?: "original" | "text" | "image-file" }
  | {
      action: "update";
      id: string;
      note?: string;
      tags?: string[];
      editedText?: string | null;
      pinned?: boolean;
      favoritePinned?: boolean;
      order?: number;
      favoriteOrder?: number;
      groups?: string[];
    }
  | { action: "favorite"; id: string; enabled: boolean }
  | { action: "history.remove"; ids: string[] }
  | { action: "settings"; patch?: Partial<ClipboardSettings> }
  | { action: "groups"; name?: string; kind?: "gallery" | "favorite"; deleteId?: string }
  | { action: "merge"; ids: string[]; kind: "text" | "rich" | "files"; separator?: string }
  | { action: "gallery.import"; groupId?: string }
  | { action: "cleanup.preview"; ids?: string[]; outsideVisibleRange?: boolean }
  | { action: "cleanup.confirm"; token: string }
  | { action: "emoji.list" }
  | { action: "emoji.add"; symbol: string; name?: string; group?: string }
  | { action: "emoji.remove"; id: string }
  | { action: "emoji.copy"; id: string };
