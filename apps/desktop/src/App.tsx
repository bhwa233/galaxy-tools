import { lazy, Suspense } from "react";
import { Spinner } from "./components/ui/spinner";
import {
  DesktopAppearance,
  DesktopWindow,
  WindowLifecycle,
} from "./features/windows/DesktopWindow";
import { getInitialRoute } from "./features/windows/windowRoutes";

const Launcher = lazy(() =>
  import("./features/launcher/Launcher").then((module) => ({ default: module.Launcher })),
);
const SettingsWindow = lazy(() =>
  import("./features/settings/SettingsWindow").then((module) => ({
    default: module.SettingsWindow,
  })),
);
const CapsuleHost = lazy(() =>
  import("./features/capsules/CapsuleHost").then((module) => ({ default: module.CapsuleHost })),
);
// Compatibility for installed notes packages predating declared renderer entries.
// New plugin entries mount their own page and never import this host router.
const MainWindow = lazy(() =>
  import("./features/notes/MainWindow").then((module) => ({ default: module.MainWindow })),
);
const NotePad = lazy(() =>
  import("./features/notes/NotePad").then((module) => ({ default: module.NotePad })),
);
const TileShowcase = lazy(() =>
  import("./components/TileShowcase").then((module) => ({ default: module.TileShowcase })),
);

export default function App() {
  const route = getInitialRoute();
  const loading = (
    <div className="flex h-screen items-center justify-center bg-background">
      <Spinner />
    </div>
  );
  if (route.view === "capsule")
    return (
      <Suspense fallback={loading}>
        <DesktopAppearance />
        <CapsuleHost />
        <WindowLifecycle prepareClose={false} />
      </Suspense>
    );
  const content =
    route.view === "settings" ? (
      <SettingsWindow />
    ) : route.view === "launcher" ? (
      <Launcher />
    ) : route.view === "main" ? (
      <MainWindow />
    ) : route.view === "notepad" ? (
      <NotePad initialNoteId={route.noteId} />
    ) : (
      <TileShowcase noteId={route.noteId} />
    );
  return (
    <Suspense fallback={loading}>
      <DesktopWindow
        prepareClose={route.view === "launcher" || route.view === "settings"}
        transparent={route.view !== "launcher" && route.view !== "settings"}
      >
        {content}
      </DesktopWindow>
    </Suspense>
  );
}
