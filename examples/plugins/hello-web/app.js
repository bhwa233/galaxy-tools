import { createPluginClient } from "./sdk.js";

const client = createPluginClient();
const input = document.querySelector("#message");
const status = document.querySelector("#status");
let dirty = false;
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme.effective;
  document.querySelector("#theme").textContent = theme.effective;
};
const showActivation = (activation) => {
  document.querySelector("#activation").textContent =
    activation.context?.kind === "text"
      ? activation.context.text
      : (activation.commandId ?? "打开页面");
};
const save = async () => {
  await client.storage.set("message", input.value);
  dirty = false;
  status.textContent = "已保存到插件私有存储";
};
input.addEventListener("input", () => {
  dirty = true;
  status.textContent = "关闭页面或停用插件前会保存";
});
document.querySelector("#save").addEventListener("click", () => {
  void save().catch((error) => {
    status.textContent = error.message;
  });
});
document.querySelector("#close").addEventListener("click", () => {
  void client.close().catch((error) => {
    status.textContent = error.message;
  });
});
client.onPrepareStop(async () => {
  if (dirty) await save();
  return { ok: true };
});
client.onTheme(applyTheme);
client.onActivation(showActivation);
try {
  const context = await client.context();
  document.querySelector("#owner").textContent =
    `${context.owner.pluginId}@${context.owner.version}`;
  document.querySelector("#instance").textContent = context.owner.instanceId;
  applyTheme(context.theme);
  const message = await client.storage.get("message");
  input.value = typeof message === "string" ? message : "";
  await client.registerCommand("open", showActivation);
  status.textContent = "已连接；页面关闭后插件仍保持启用";
} catch (error) {
  status.textContent = error.message;
}
