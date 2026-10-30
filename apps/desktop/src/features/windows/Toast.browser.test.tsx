import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useState } from "react";
import { ToastContainer, showToast } from "../../components/Toast";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";

function ModalFeedback() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开弹窗</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>通知测试</DialogTitle>
          <DialogDescription>操作通知不改变当前编辑状态。</DialogDescription>
          <Input aria-label="弹窗草稿" />
        </DialogContent>
      </Dialog>
      <ToastContainer />
    </>
  );
}

// A window's feedback must remain operable above a modal without moving focus;
// repeated copies used to produce separate notifications with fresh timers.
it("merges repeated feedback and keeps its close button operable above a Base UI modal", async () => {
  const view = await render(<ModalFeedback />);
  try {
    await page.getByRole("button", { name: "打开弹窗" }).click();
    const draft = page.getByRole("textbox", { name: "弹窗草稿" });
    await draft.fill("保留这份草稿");
    showToast("复制完成测试", "success");
    showToast("复制完成测试", "success");
    const viewport = page.getByRole("region", { name: "操作通知", exact: true });
    await expect.element(viewport.getByText("复制完成测试", { exact: true })).toBeVisible();
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
    expect(document.activeElement).toBe(draft.element());
    await userEvent.hover(viewport.getByText("复制完成测试", { exact: true }));
    await viewport.getByRole("button", { name: "关闭通知", exact: true }).click();
    await expect
      .element(viewport.getByText("复制完成测试", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog", { name: "通知测试" })).toBeVisible();
    await expect.element(draft).toHaveValue("保留这份草稿");
  } finally {
    await view.unmount();
  }
});
