// Keep the installed shadcn source authoritative; the UI build bundles these
// exports and emits self-contained declarations for independent npm consumers.
export { Button, buttonVariants } from "../../../src/components/ui/button.js";
export {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
} from "../../../src/components/ui/alert.js";
export { Badge, badgeVariants } from "../../../src/components/ui/badge.js";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "../../../src/components/ui/card.js";
export { Input } from "../../../src/components/ui/input.js";
export { Textarea } from "../../../src/components/ui/textarea.js";
export { Spinner } from "../../../src/components/ui/spinner.js";
