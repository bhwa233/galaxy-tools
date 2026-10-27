import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupSelections } from "./backup-selections.js";

const snapshot = {
  directory: "/owned/snapshots/a",
  manifestFingerprint: "a".repeat(64),
};
function selection(selections: BackupSelections, caller: string) {
  return selections.register(caller, selections.beginInspection(caller), snapshot);
}

afterEach(() => vi.useRealTimers());

describe("backup selection authority", () => {
  it("rejects a foreign caller without consuming the owner's verified snapshot", async () => {
    const selections = new BackupSelections();
    const id = selection(selections, "owner-document");
    const restore = vi.fn(async (directory: string, fingerprint: string) => ({
      directory,
      fingerprint,
    }));

    expect(() => selections.release("another-document", id)).toThrow();
    await expect(selections.restore("another-document", id, restore)).rejects.toMatchObject({
      code: "permissionDenied",
    });
    expect(restore).not.toHaveBeenCalled();
    await expect(selections.restore("owner-document", id, restore)).resolves.toEqual({
      directory: snapshot.directory,
      fingerprint: snapshot.manifestFingerprint,
    });
    await expect(selections.restore("owner-document", id, restore)).rejects.toMatchObject({
      code: "backupSelectionChanged",
    });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("revokes a previous preview as soon as reselect starts and ignores a late exact release", async () => {
    const selections = new BackupSelections();
    const caller = "owner-document";
    const previous = selection(selections, caller);
    const canceledPicker = selections.beginInspection(caller);
    // A canceled picker never registers a replacement; the prior confirmation
    // must already be unusable, rather than remaining live behind a hidden card.
    await expect(selections.restore(caller, previous, async () => "bad")).rejects.toMatchObject({
      code: "backupSelectionChanged",
    });
    const failedInspection = selections.beginInspection(caller);
    expect(selections.isInspectionCurrent(caller, canceledPicker)).toBe(false);
    expect(() => selections.register(caller, canceledPicker, snapshot)).toThrow();
    // A failed inspection also creates no token. Starting over retires its
    // request, so even its delayed completion cannot register an old snapshot.
    const current = selection(selections, caller);
    expect(() => selections.register(caller, failedInspection, snapshot)).toThrow();
    selections.release(caller, previous);
    await expect(selections.restore(caller, current, async () => "restored")).resolves.toBe(
      "restored",
    );

    const explicitlyCanceled = selection(selections, caller);
    selections.release(caller, explicitlyCanceled);
    await expect(
      selections.restore(caller, explicitlyCanceled, async () => "bad"),
    ).rejects.toMatchObject({ code: "backupSelectionChanged" });
  });

  it("retires both registered tokens and late inspections without revoking another document", async () => {
    const selections = new BackupSelections();
    const closedId = selection(selections, "closed-document");
    const lateRequest = selections.beginInspection("navigated-document");
    const otherId = selection(selections, "other-document");

    selections.revokeCaller("closed-document");
    selections.revokeCaller("navigated-document");
    expect(selections.isInspectionCurrent("navigated-document", lateRequest)).toBe(false);
    expect(() => selections.register("navigated-document", lateRequest, snapshot)).toThrow();
    await expect(
      selections.restore("closed-document", closedId, async () => "bad"),
    ).rejects.toMatchObject({ code: "backupSelectionChanged" });
    await expect(
      selections.restore("other-document", otherId, async () => "other restored"),
    ).resolves.toBe("other restored");
  });

  it("blocks concurrent restores, preserves a failed selection for retry, and enforces expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    const selections = new BackupSelections();
    const caller = "owner-document";
    const id = selection(selections, caller);
    let fail!: (reason: Error) => void;
    const failedSave = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const first = selections.restore(caller, id, () => failedSave);
    await expect(selections.restore(caller, id, async () => "bad")).rejects.toMatchObject({
      code: "maintenance",
    });
    const rejected = expect(first).rejects.toThrow("owned save rejected");
    fail(new Error("owned save rejected"));
    await rejected;

    let complete!: (value: string) => void;
    const accepted = selections.restore(
      caller,
      id,
      () => new Promise<string>((resolve) => (complete = resolve)),
    );
    // Closing the originating document after acceptance retires future use;
    // it must not terminate an already accepted restore transaction.
    selections.revokeCaller(caller);
    complete("retry committed");
    await expect(accepted).resolves.toBe("retry committed");
    await expect(selections.restore(caller, id, async () => "bad")).rejects.toMatchObject({
      code: "backupSelectionChanged",
    });

    const expired = selection(selections, caller);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    const restoreExpired = vi.fn(async () => "bad");
    await expect(selections.restore(caller, expired, restoreExpired)).rejects.toMatchObject({
      code: "backupSelectionChanged",
    });
    expect(restoreExpired).not.toHaveBeenCalled();
  });
});
