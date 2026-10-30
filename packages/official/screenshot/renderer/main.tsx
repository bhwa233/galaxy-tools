import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { ScreenshotHistoryWorkspace } from "../../../../apps/desktop/src/features/screenshot/ScreenshotHistoryWorkspace";
const Page = () => (
  <PluginWindow>{({ onClose }) => <ScreenshotHistoryWorkspace onClose={onClose} />}</PluginWindow>
);
void mountDesktopApp(Page);
