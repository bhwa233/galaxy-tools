import { NotePad } from "../features/notes/NotePad";

interface TileShowcaseProps {
  noteId?: string;
}

export function TileShowcase({ noteId }: TileShowcaseProps) {
  return <NotePad initialNoteId={noteId} initialSurfaceMode="tile" />;
}
