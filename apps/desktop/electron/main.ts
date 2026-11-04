if (process.argv.includes("--spark233-utools-runner")) {
  const { startUToolsRunner } = await import("./plugins/utools-runner.cjs");
  await startUToolsRunner();
} else {
  const { startDesktopHost } = await import("./runtime.js");
  startDesktopHost();
}
