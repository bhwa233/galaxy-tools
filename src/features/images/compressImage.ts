// 大图自动压缩：纯判定逻辑与 canvas 适配层分离，判定逻辑可单测。
// 仅处理 png/jpeg/webp；gif/svg/bmp 不处理（保动画/矢量/兼容）。

export const COMPRESS_MAX_BYTES = 8 * 1024 * 1024;
export const COMPRESS_MAX_EDGE = 2048;
const COMPRESSIBLE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface CompressionPlan {
  compress: boolean;
  width: number;
  height: number;
}

export function planImageCompression(
  bytes: number,
  width: number,
  height: number,
): CompressionPlan {
  const longEdge = Math.max(width, height);
  const oversize = bytes > COMPRESS_MAX_BYTES || longEdge > COMPRESS_MAX_EDGE;
  if (!oversize || !Number.isFinite(width) || !Number.isFinite(height) || longEdge <= 0) {
    return { compress: false, width, height };
  }
  const scale = Math.min(1, COMPRESS_MAX_EDGE / longEdge);
  return {
    compress: true,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface CompressedImage {
  bytes: Uint8Array;
  type: string;
}

// 返回 null 表示保持原图（不需要、不适用或压缩失败/反而更大）。
export async function compressImageFile(file: File): Promise<CompressedImage | null> {
  if (!COMPRESSIBLE_TYPES.has(file.type)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const plan = planImageCompression(file.size, bitmap.width, bitmap.height);
    if (!plan.compress) return null;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);
    const blob = await canvasToBlob(canvas, file.type);
    if (!blob || blob.size >= file.size) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: file.type };
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
}
