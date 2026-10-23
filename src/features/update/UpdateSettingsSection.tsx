// The Tauri updater cannot install Electron packages. No network request is made here.
export function UpdateSettingsSection(_props: { mode?: "settingsOnly" | "checkOnly" | "full" }) {
  return (
    <section className="rounded-xl border border-paper-deep/40 p-4 text-sm text-ink-soft">
      <h3 className="font-medium mb-2">更新</h3>
      <p>Electron 迁移版暂未接入自动更新，请通过本项目提供的 Electron 安装包更新。</p>
    </section>
  );
}
