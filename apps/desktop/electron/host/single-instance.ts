import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Keep one GUI owner per OS user while retaining each profile's browser storage. */
export function acquireDesktopInstance(profileDirectory: string, isolatedProfile = false): boolean {
  // Electron keys its native singleton by userData. Configure that identity
  // before requesting the lock, then restore the real profile before any session exists.
  const lockDirectory = isolatedProfile
    ? profileDirectory
    : path.join(app.getPath("appData"), "spark233", "instance-lock");
  fs.mkdirSync(lockDirectory, { recursive: true });
  app.setPath("userData", lockDirectory);
  try {
    return app.requestSingleInstanceLock();
  } finally {
    app.setPath("userData", profileDirectory);
  }
}
