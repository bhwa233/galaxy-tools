import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { MainWindow } from "../../../../apps/desktop/src/features/notes/MainWindow";
import { NotePad } from "../../../../apps/desktop/src/features/notes/NotePad";
import { TileShowcase } from "../../../../apps/desktop/src/components/TileShowcase";
import { CapsuleHost } from "../../../../apps/desktop/src/features/capsules/CapsuleHost";
import {
  DesktopAppearance,
  WindowLifecycle,
} from "../../../../apps/desktop/src/features/windows/DesktopWindow";
const Page = () => {
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "capsule")
    return (
      <>
        <DesktopAppearance />
        <CapsuleHost />
        <WindowLifecycle prepareClose={false} />
      </>
    );
  return (
    <PluginWindow documentWindow>
      {() => {
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
};
void mountDesktopApp(Page);
