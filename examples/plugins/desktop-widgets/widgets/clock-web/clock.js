import { connectWidget } from "/__sdk__/widget.js";

const clock = document.querySelector("#time");
const date = document.querySelector("#date");
const details = document.querySelector("#details");
const status = document.querySelector("#status");
const label = document.querySelector("#label");
let locale = "zh-CN";
let timestamp;
let expanded = false;
let visible = true;
let api;

function render() {
  if (!visible || typeof timestamp !== "number") return;
  const now = new Date(timestamp);
  if (!Number.isFinite(now.getTime())) return;
  clock.textContent = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  clock.dateTime = now.toISOString();
  date.textContent = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(now);
  date.hidden = !expanded;
}

details.addEventListener("click", async () => {
  if (!api) return;
  const next = !expanded;
  details.disabled = true;
  try {
    await api.resize({ width: 260, height: next ? 156 : 116 });
    expanded = next;
    details.setAttribute("aria-expanded", String(expanded));
    details.textContent = locale.startsWith("en")
      ? expanded
        ? "Hide date"
        : "Show date"
      : expanded
        ? "隐藏日期"
        : "显示日期";
    status.textContent = "";
    render();
  } catch {
    status.textContent = locale.startsWith("en")
      ? "Unable to resize this card."
      : "暂时无法调整卡片大小";
  } finally {
    details.disabled = false;
  }
});

try {
  api = await connectWidget();
  api.onInit((init) => {
    locale = init.locale;
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = init.theme;
    label.textContent = locale.startsWith("en") ? "Local time" : "现在";
    details.textContent = locale.startsWith("en")
      ? expanded
        ? "Hide date"
        : "Show date"
      : expanded
        ? "隐藏日期"
        : "显示日期";
    status.textContent = "";
    render();
  });
  api.onData((frame) => {
    timestamp = frame.values.timestamp;
    render();
  });
  api.onVisibility((value) => {
    visible = value;
    render();
  });
  window.addEventListener("pagehide", () => api.dispose(), { once: true });
} catch {
  status.textContent = "卡片未连接，请重新打开";
  details.disabled = true;
}
