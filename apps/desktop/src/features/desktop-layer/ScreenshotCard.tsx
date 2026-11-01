import { useState } from "react";
import { EyeOff, Maximize2, Pencil, Pin, PinOff, X, ZoomIn, ZoomOut } from "lucide-react";
import type { LayerScreenshotAction, LayerScreenshotImage } from "../../../shared/layer-contract";
import { Button } from "../../components/ui/button";
import { getErrorMessage } from "../notes/api";

interface ScreenshotCardProps {
  image: LayerScreenshotImage;
  title: string;
  width: number;
  scaleFactor: number;
  pinned: boolean;
  disabled: boolean;
  locale: string;
  onAction: (action: LayerScreenshotAction, value?: number) => Promise<unknown>;
}

/** Reuse the trusted layer and its pointer/editor handling. The image is only a
 * surface-bound handle; this view never receives filesystem paths or scene data. */
export function ScreenshotCard({
  image,
  title,
  width,
  scaleFactor,
  pinned,
  disabled,
  locale,
  onAction,
}: ScreenshotCardProps) {
  const [failedImage, setFailedImage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const text = (zh: string, en: string) => (locale.startsWith("zh") ? zh : en);
  const imageUrl =
    /^spark233:\/\/app\/__screenshot-image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      image.imageUrl,
    )
      ? image.imageUrl
      : undefined;
  const run = async (action: LayerScreenshotAction, value?: number) => {
    if (disabled || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onAction(action, value);
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  const controls: Array<{
    action: LayerScreenshotAction;
    value?: number;
    label: string;
    icon: typeof Pencil;
    disabled?: boolean;
  }> = [
    {
      action: "edit" as const,
      label: text("继续标注", "Edit annotations"),
      icon: Pencil,
      disabled: !image.editable,
    },
    {
      action: "pin" as const,
      label: pinned ? text("取消置顶", "Unpin") : text("置顶", "Always on top"),
      icon: pinned ? PinOff : Pin,
    },
    { action: "zoom" as const, value: 0.8, label: text("缩小", "Zoom out"), icon: ZoomOut },
    { action: "fit" as const, label: text("适合屏幕", "Fit to screen"), icon: Maximize2 },
    { action: "zoom" as const, value: 1.25, label: text("放大", "Zoom in"), icon: ZoomIn },
    { action: "hide" as const, label: text("隐藏贴图", "Hide pinned image"), icon: EyeOff },
    { action: "close" as const, label: text("关闭贴图", "Close pinned image"), icon: X },
  ];
  return (
    <div
      className="layer-screenshot"
      data-screenshot-card="true"
      onPointerDown={(event) => {
        if (!disabled && event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
      }}
    >
      {imageUrl && failedImage !== imageUrl ? (
        <img
          className="layer-screenshot-image"
          src={imageUrl}
          alt={title}
          draggable={false}
          onError={(event) => setFailedImage(event.currentTarget.currentSrc || imageUrl)}
        />
      ) : (
        <div className="layer-card-fault" role="status">
          {text("贴图图片暂不可用", "Pinned image is unavailable")}
        </div>
      )}
      <div
        className="layer-screenshot-toolbar"
        role="toolbar"
        aria-label={text("贴图操作", "Pinned image actions")}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {controls.map(({ action, value, label, icon: Icon, disabled: unavailable }, index) => (
          <Button
            key={`${action}:${index}`}
            type="button"
            size="icon-sm"
            variant="ghost"
            title={label}
            aria-label={label}
            disabled={disabled || pending || unavailable}
            data-screenshot-action={action}
            onClick={() => void run(action, value)}
          >
            <Icon aria-hidden width={14} height={14} />
          </Button>
        ))}
        <span className="layer-screenshot-scale" aria-hidden>
          {Math.round((width * scaleFactor * 100) / Math.max(1, image.pixelWidth))}%
        </span>
      </div>
      {error && (
        <div className="layer-action-error" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
