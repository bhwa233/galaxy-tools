import { describe, expect, it } from "vitest";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import remarkImageSize, { normalizeImageWidth } from "./remarkImageSize";

function parse(markdown: string) {
  const processor = unified().use(remarkParse).use(remarkImageSize);
  return processor.run(processor.parse(markdown)) as Promise<any>;
}

describe("normalizeImageWidth", () => {
  it("accepts percent and pixel values within bounds", () => {
    expect(normalizeImageWidth("75%")).toBe("75%");
    expect(normalizeImageWidth("100%")).toBe("100%");
    expect(normalizeImageWidth("600px")).toBe("600px");
    expect(normalizeImageWidth("4096px")).toBe("4096px");
  });

  it("rejects malformed or out-of-range values", () => {
    expect(normalizeImageWidth("0%")).toBeUndefined();
    expect(normalizeImageWidth("101%")).toBeUndefined();
    expect(normalizeImageWidth("4px")).toBeUndefined();
    expect(normalizeImageWidth("5000px")).toBeUndefined();
    expect(normalizeImageWidth("75")).toBeUndefined();
    expect(normalizeImageWidth("auto")).toBeUndefined();
    expect(normalizeImageWidth(75)).toBeUndefined();
  });
});

describe("remarkImageSize", () => {
  it("consumes a width suffix and tags the image", async () => {
    const tree = await parse("![pic](images/a/b.png){width=75%}");
    const paragraph = tree.children[0];
    const image = paragraph.children[0];
    expect(image.url).toBe("images/a/b.png");
    expect(image.data?.hProperties?.["data-width"]).toBe("75%");
    expect(paragraph.children).toHaveLength(1);
  });

  it("keeps trailing text after the suffix", async () => {
    const tree = await parse("![pic](images/a/b.png){width=600px} 后记");
    const paragraph = tree.children[0];
    expect(paragraph.children[1]?.value).toBe(" 后记");
  });

  it("leaves invalid suffixes untouched as plain text", async () => {
    const tree = await parse("![pic](images/a/b.png){width=120%}");
    const paragraph = tree.children[0];
    expect(paragraph.children[1]?.value).toBe("{width=120%}");
    expect(paragraph.children[0]?.data?.hProperties).toBeUndefined();
  });

  it("ignores images without a suffix", async () => {
    const tree = await parse("![pic](images/a/b.png)");
    const paragraph = tree.children[0];
    expect(paragraph.children[0]?.data?.hProperties).toBeUndefined();
  });

  it("does not alter the markdown when re-serialized without the plugin applied twice", async () => {
    const processor = unified().use(remarkParse).use(remarkImageSize).use(remarkStringify);
    const output = processor.processSync("![pic](images/a/b.png)").toString();
    expect(output).toContain("![pic](images/a/b.png)");
  });
});
