import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

const [runRoot, packageRoot, boundary] = process.argv.slice(2);
if (!runRoot || !packageRoot || !boundary)
  throw new Error("Expected isolated run directory, package directory and Win32 boundary");
mkdirSync(runRoot, { recursive: true });
const observations = [];
const native = (...args) => execFileSync(boundary, args, { encoding: "utf8", windowsHide: true });
// Verify the actual station before loading any code that can access a clipboard.
const context = native("context");
if (!context.startsWith("PRIVATE_STATION\t") || context.includes("WinSta0"))
  throw new Error("Not an isolated station");
const require = createRequire(path.join(packageRoot, "package.json"));
const clipboard = require("@crosscopy/clipboard");
let watcher;
let notifications = 0;
const record = (name, details) => {
  observations.push({ name, ...details });
  console.log(name, JSON.stringify(details));
};
const check = (ok, description) => {
  if (!ok) throw new Error(description);
};
const fixture = path.join(runRoot, "spark233-file-reference.txt");
const firstSnapshot = path.join(runRoot, "snapshot-before.bin");
const restoredSnapshot = path.join(runRoot, "snapshot-restored.bin");
writeFileSync(fixture, "isolated file reference");

try {
  record("context", {
    station: context.trim(),
    node: process.version,
    package: require("@crosscopy/clipboard/package.json").version,
  });
  await clipboard.clear();
  watcher = clipboard.startWatch(() => {
    notifications += 1;
  });
  check(watcher.isRunning, "Clipboard watcher did not start");
  // Allow the native watcher thread to enter its message loop once.
  await pause(100);
  native("seed", fixture);
  const deadline = Date.now() + 3000;
  while (!notifications && Date.now() < deadline) await pause(20);
  check(notifications > 0, "No real clipboard listener notification");
  const text = await clipboard.getText();
  const html = await clipboard.getHtml();
  const rtf = await clipboard.getRtf();
  const files = await clipboard.getFiles();
  check(
    text.includes("spark233 中文") &&
      html.includes("<b>spark233 中文</b>") &&
      rtf.includes("\\rtf1"),
    "Mixed-format addon read failed",
  );
  check(
    files.length === 1 && path.resolve(files[0]) === fixture,
    "File reference was not preserved",
  );
  record("mixed-addon-read", {
    formats: clipboard.availableFormats(),
    text,
    html,
    rtf,
    files,
    notifications,
  });
  record("raw-snapshot", { result: native("snapshot", firstSnapshot).trim() });
  const rawHtml = Buffer.from(await clipboard.getBuffer("HTML Format"));
  const rawRtf = Buffer.from(await clipboard.getBuffer("Rich Text Format"));
  record("registered-raw-read", {
    htmlBytes: rawHtml.length,
    rtfBytes: rawRtf.length,
    htmlHash: createHash("sha256").update(rawHtml).digest("hex"),
  });

  // The published API exposes one setter per format. Observe whether chaining
  // setters retains the other formats instead of assuming atomic replay exists.
  await clipboard.setText("setter text");
  await clipboard.setHtml("<b>setter html</b>");
  await clipboard.setRtf("{\\rtf1 setter rtf}");
  const formatsAfterSetters = clipboard.availableFormats();
  record("single-setter-semantics", {
    formats: formatsAfterSetters,
    hasText: clipboard.hasText(),
    hasHtml: clipboard.hasHtml(),
    hasRtf: clipboard.hasRtf(),
  });
  await clipboard.setFiles([fixture]);
  check((await clipboard.getFiles())[0] === fixture, "Addon setFiles/getFiles failed");
  record("file-setter-roundtrip", { files: await clipboard.getFiles() });

  native("restore", firstSnapshot);
  native("snapshot", restoredSnapshot);
  const before = readFileSync(firstSnapshot);
  const after = readFileSync(restoredSnapshot);
  check(before.equals(after), "Raw mixed-format restoration changed snapshot bytes");
  check(
    (await clipboard.getText()) === text && (await clipboard.getFiles())[0] === fixture,
    "Restored text/file reference changed",
  );
  record("raw-replay", {
    byteIdentical: true,
    bytes: before.length,
    sha256: createHash("sha256").update(before).digest("hex"),
  });

  native("seed-sensitive", fixture);
  const sensitiveFormats = clipboard.availableFormats();
  const history = Buffer.from(await clipboard.getBuffer("CanIncludeInClipboardHistory"));
  check(
    sensitiveFormats.includes("ExcludeClipboardContentFromMonitorProcessing") &&
      history.length >= 4 &&
      history.readUInt32LE() === 0,
    "Sensitive Windows markers were not readable",
  );
  let suppressed = false;
  try {
    native("snapshot", path.join(runRoot, "must-not-capture-sensitive.bin"));
  } catch (error) {
    suppressed = error.status === 3;
  }
  check(suppressed, "Sensitive clipboard capture was not suppressed");
  record("sensitive-markers", {
    exclusionPresent: true,
    canIncludeHistory: history.readUInt32LE(),
    captureSuppressed: suppressed,
  });

  watcher.stop();
  check(!watcher.isRunning, "Watcher stop did not update state");
  await pause(100);
  const afterStop = notifications;
  await clipboard.setText("after watcher stop");
  await pause(100);
  check(notifications === afterStop, "Watcher still emitted after stop");
  record("watcher-stop", {
    running: watcher.isRunning,
    afterStopNotifications: notifications - afterStop,
  });
  await clipboard.clear();
  writeFileSync(
    path.join(runRoot, "report.json"),
    JSON.stringify({ successful: true, observations }, null, 2),
  );
} catch (error) {
  writeFileSync(
    path.join(runRoot, "report.json"),
    JSON.stringify({ successful: false, error: String(error), observations }, null, 2),
  );
  throw error;
} finally {
  watcher?.stop();
}
