import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AboutPanel } from "./AboutPanel";

vi.mock("../platform/desktop", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.0.4")),
  openUrl: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../generated/contributors.json", () => ({
  default: [
    {
      login: "TestUser",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      html_url: "https://github.com/TestUser",
    },
  ],
}));

describe("AboutPanel", () => {
  test("renders app identity and update policy", () => {
    const markup = renderToStaticMarkup(<AboutPanel onClose={vi.fn()} />);

    expect(markup).toContain("关于");
    expect(markup).toContain("spark233");
    expect(markup).toContain("模块化桌面启动器与本地工具集");
    expect(markup).toContain("更新");
    expect(markup).toContain("检查更新");
    // The about panel is check-only: automatic or download settings stay in the
    // settings window, and the host owns install execution.
    expect(markup).not.toContain("自动检查更新");
    expect(markup).not.toContain("自动下载");
  });

  test("renders github link, feedback link, and contributors", () => {
    const markup = renderToStaticMarkup(<AboutPanel onClose={vi.fn()} />);

    expect(markup).toContain("GitHub");
    expect(markup).toContain("反馈问题");
    expect(markup).toContain("许可证");
    expect(markup).toContain("贡献者");
    expect(markup).toContain("TestUser");
  });
});
