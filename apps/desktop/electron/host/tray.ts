import { Tray, nativeTheme } from "electron";
import type { DisplayBalloonOptions, Menu, NativeImage } from "electron";

export interface TrayControllerOptions {
  icon: string | NativeImage;
  themeIcons?: { light: string; dark: string };
  getIcon?: () => string | NativeImage;
  title: string;
  getMenu: () => Menu | Promise<Menu>;
  onClick: () => void;
  onBalloonClick: () => void;
}

/** Own only the host tray; menu content and reminder routing stay with the host. */
export class TrayController {
  private readonly tray: Tray;
  private disposed = false;
  private refreshGeneration = 0;

  constructor(private readonly options: TrayControllerOptions) {
    this.tray = new Tray(options.icon);
    this.tray.setToolTip(options.title);
    this.tray.on("click", options.onClick);
    this.tray.on("balloon-click", options.onBalloonClick);
    this.applyThemeIcon();
    if (options.themeIcons || options.getIcon) nativeTheme.on("updated", this.applyThemeIcon);
  }

  private applyThemeIcon = (): void => {
    if (this.disposed || this.tray.isDestroyed()) return;
    if (this.options.getIcon) this.tray.setImage(this.options.getIcon());
    else if (this.options.themeIcons)
      this.tray.setImage(
        this.options.themeIcons[nativeTheme.shouldUseDarkColors ? "dark" : "light"],
      );
  };

  refresh(): void {
    if (this.disposed || this.tray.isDestroyed()) return;
    this.applyThemeIcon();
    const generation = ++this.refreshGeneration;
    void Promise.resolve()
      .then(() => this.options.getMenu())
      .then((menu) => {
        if (!this.disposed && !this.tray.isDestroyed() && generation === this.refreshGeneration)
          this.tray.setContextMenu(menu);
      })
      .catch((error) => {
        if (!this.disposed && generation === this.refreshGeneration) console.error(error);
      });
  }

  displayBalloon(options: DisplayBalloonOptions): void {
    if (this.disposed || this.tray.isDestroyed()) return;
    this.tray.displayBalloon(options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    this.tray.removeListener("click", this.options.onClick);
    this.tray.removeListener("balloon-click", this.options.onBalloonClick);
    nativeTheme.removeListener("updated", this.applyThemeIcon);
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
