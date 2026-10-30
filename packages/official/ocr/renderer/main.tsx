import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { OcrWorkspace } from "../../../../apps/desktop/src/features/ocr/OcrWorkspace";
const Page = () => (
  <PluginWindow>
    {({ payload, onClose, info }) => (
      <OcrWorkspace
        initialResult={payload}
        onClose={onClose}
        onResult={() => {}}
        availableTargets={{
          notes: info.commands.includes("spark233.notes:new"),
          dictionary: info.commands.includes("spark233.translation:search"),
          translate: info.commands.includes("spark233.translation:translate"),
        }}
      />
    )}
  </PluginWindow>
);
void mountDesktopApp(Page);
