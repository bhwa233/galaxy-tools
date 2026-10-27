import { afterEach } from "vitest";
import { cleanup } from "vitest-browser-react";
import "../../App.css";

afterEach(async () => {
  await cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});
