import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("parseCliArgs", () => {
  it("returns no command and no mcp for plain argv", () => {
    expect(parseCliArgs(["spark233.exe"])).toEqual({ command: undefined, mcp: false });
  });

  it("recognizes each command flag", () => {
    expect(parseCliArgs(["exe", "--new"]).command).toBe("new");
    expect(parseCliArgs(["exe", "--show"]).command).toBe("show");
    expect(parseCliArgs(["exe", "--hide"]).command).toBe("hide");
    expect(parseCliArgs(["exe", "--toggle"]).command).toBe("toggle");
    expect(parseCliArgs(["exe", "--list"]).command).toBe("list");
    expect(parseCliArgs(["exe", "--exit"]).command).toBe("exit");
  });

  it("keeps the first command when several flags appear", () => {
    expect(parseCliArgs(["exe", "--hide", "--show"]).command).toBe("hide");
  });

  it("ignores unknown flags and file arguments", () => {
    expect(parseCliArgs(["exe", "--force", "C:\\tmp\\note.md", "--smoke-output=x"])).toEqual({
      command: undefined,
      mcp: false,
    });
  });

  it("flags mcp mode without treating it as a command", () => {
    expect(parseCliArgs(["exe", "--mcp"])).toEqual({ command: undefined, mcp: true });
    expect(parseCliArgs(["exe", "--mcp", "--new"])).toEqual({ command: "new", mcp: true });
  });
});
