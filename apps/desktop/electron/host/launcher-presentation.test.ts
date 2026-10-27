import { expect, it } from "vitest";
import { shouldHideLauncher } from "./launcher-presentation";

it("hides an externally blurred launcher while keeping settings, owned pickers and live composition visible", () => {
  const blurred = {
    label: "launcher",
    visible: true,
    focused: false,
    ownedDialog: false,
    composingUntil: 0,
    devToolsFocused: false,
  };
  expect(shouldHideLauncher(blurred, 100)).toBe(true);
  expect(shouldHideLauncher({ ...blurred, label: "settings" }, 100)).toBe(false);
  expect(shouldHideLauncher({ ...blurred, focused: true }, 100)).toBe(false);
  expect(shouldHideLauncher({ ...blurred, ownedDialog: true }, 100)).toBe(false);
  expect(shouldHideLauncher({ ...blurred, composingUntil: 150 }, 100)).toBe(false);
  expect(shouldHideLauncher({ ...blurred, composingUntil: 150 }, 151)).toBe(true);
});
