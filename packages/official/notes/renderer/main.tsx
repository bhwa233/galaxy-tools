import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { MainWindow } from "../../../../apps/desktop/src/features/notes/MainWindow";
import { NotePad } from "../../../../apps/desktop/src/features/notes/NotePad";
import { TileShowcase } from "../../../../apps/desktop/src/components/TileShowcase";
const Page = () => (
  <PluginWindow documentWindow>
    {() => {
      const params = new URLSearchParams(location.search);
      return params.get("view") === "notepad" ? (
        <NotePad initialNoteId={params.get("noteId") ?? undefined} />
      ) : params.get("view") === "tile" ? (
        <TileShowcase noteId={params.get("noteId") ?? undefined} />
      ) : (
        <MainWindow />
      );
    }}
  </PluginWindow>
);
void mountDesktopApp(Page);
