import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Icons are decoded by the host from the installed package, never remote URLs
 * or executable SVG markup supplied by a renderer. */
export function PluginIcon({
  icon,
  monochrome,
  className,
}: {
  icon?: string;
  monochrome?: boolean;
  className?: string;
}) {
  if (!icon || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon))
    return <Puzzle aria-hidden="true" className={className} strokeWidth={1.75} />;
  // Reuse the host-decoded PNG as an alpha mask; never inject package SVG.
  if (monochrome)
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block bg-primary", className)}
        style={{
          maskImage: `url(${icon})`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    );
  return <img src={icon} alt="" aria-hidden="true" className={className} />;
}
