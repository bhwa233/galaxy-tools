import { Toaster, toast } from "./ui/toast";

export type ToastType = "success" | "error" | "warning" | "info";

/** Keep notifications local to the current renderer. Base UI owns lifetime,
 * hover/focus pause and stacking; stable IDs merge repeated operation feedback. */
export function showToast(message: string, type: ToastType = "error") {
  toast.add({
    id: JSON.stringify([type, message]),
    title: message,
    type,
    timeout: type === "success" || type === "info" ? 2500 : 5000,
    priority: type === "error" || type === "warning" ? "high" : "low",
  });
}

export function ToastContainer() {
  return <Toaster limit={3} />;
}
