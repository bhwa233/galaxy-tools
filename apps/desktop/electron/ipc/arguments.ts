import { AppError } from "../persistence.js";
export function text(value: unknown): string {
  if (typeof value !== "string") throw new AppError("invalidPayload", "需要字符串参数");
  return value;
}
