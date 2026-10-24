import type { Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

// 语法：![alt](src){width=75%} / ![alt](src){width=600px}
// 尺寸后缀写在路径括号之外，不影响正文里 images/<noteId>/<file> 的字面引用
// （清理未使用图片按该子串匹配）。数值不合法时不消费，按普通文本显示。
const WIDTH_SUFFIX = /^\s*\{width=([0-9]{1,4}(?:\.[0-9])?)(%|px)\}/;
const MIN_PERCENT = 1;
const MAX_PERCENT = 100;
const MIN_PX = 8;
const MAX_PX = 4096;

export function normalizeImageWidth(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^([0-9]{1,4}(?:\.[0-9])?)(%|px)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (match[2] === "%") {
    if (amount < MIN_PERCENT || amount > MAX_PERCENT) return undefined;
  } else if (amount < MIN_PX || amount > MAX_PX) return undefined;
  return `${match[1]}${match[2]}`;
}

const remarkImageSize: Plugin<[], Root> = () => (tree) => {
  visit(tree, "image", (image, index, parent) => {
    if (index == null || !parent) return;
    const siblings = parent.children;
    const next = siblings[index + 1];
    if (!next || next.type !== "text") return;
    const match = next.value.match(WIDTH_SUFFIX);
    if (!match) return;
    const width = normalizeImageWidth(`${match[1]}${match[2]}`);
    if (!width) return;
    image.data = {
      ...image.data,
      hProperties: { ...image.data?.hProperties, "data-width": width },
    };
    const remainder = next.value.slice(match[0].length);
    if (remainder.trim()) next.value = remainder;
    else siblings.splice(index + 1, 1);
  });
};

export default remarkImageSize;
