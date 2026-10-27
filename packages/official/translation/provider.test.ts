import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "./provider.mjs";

describe("translation direction and target cache", () => {
  let directory: string;
  let translator: ReturnType<typeof createTranslator>;
  let requests: { messages: { role: string; content: string }[] }[];
  const context = () => ({ signal: new AbortController().signal, emit: vi.fn() });
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-translation-direction-"));
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Controlled compatible response" } }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    translator = createTranslator({ dataDir: directory, signal: new AbortController().signal });
    await translator.configure({
      endpoint: "https://translation.invalid/v1",
      model: "fixture-model",
      key: "",
    });
  });
  afterEach(async () => {
    await translator?.stop();
    vi.unstubAllGlobals();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // Han presence previously sent mixed Kana/Han Japanese to English. Assert
  // the real translator's chosen target and outgoing instruction, not UI text.
  it("defaults Japanese containing Han to Chinese and Chinese to English", async () => {
    const japanese = await translator.translate({ text: "日本語を勉強しています" }, context());
    expect(japanese.target).toBe("zh-CN");
    expect(requests[0].messages.find((message) => message.role === "system")?.content).toContain(
      "Simplified Chinese",
    );
    const chinese = await translator.translate({ text: "正在学习中文" }, context());
    expect(chinese.target).toBe("en");
    expect(requests[1].messages.find((message) => message.role === "system")?.content).toContain(
      "English",
    );
  });

  it("honors explicit targets and reuses only the cache for that actual target", async () => {
    const text = "日本語を勉強しています";
    const automatic = await translator.translate({ text }, context());
    expect(automatic).toMatchObject({ target: "zh-CN", cached: false });
    const overridden = await translator.translate({ text, target: "en" }, context());
    expect(overridden).toMatchObject({ target: "en", cached: false });
    expect(
      requests.at(-1)?.messages.find((message) => message.role === "system")?.content,
    ).toContain("English");
    const requestsBeforeCacheHits = requests.length;
    await expect(translator.translate({ text, target: "en" }, context())).resolves.toMatchObject({
      target: "en",
      cached: true,
    });
    await expect(translator.translate({ text }, context())).resolves.toMatchObject({
      target: "zh-CN",
      cached: true,
    });
    expect(requests.length).toBe(requestsBeforeCacheHits);
  });

  it("decodes split UTF-8 and CRLF stream frames before committing a complete translation", async () => {
    const wire = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    // Split inside the first Chinese character and inside a CRLF delimiter:
    // the actual decoder/framer must carry partial bytes and lines forward.
    const chinese = wire.indexOf(0xe4);
    const cr = wire.indexOf(13);
    const fetchStream = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(wire.slice(0, chinese + 1));
              controller.enqueue(wire.slice(chinese + 1, cr + 1));
              controller.enqueue(wire.slice(cr + 1));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchStream);
    const current = context();
    await expect(translator.translate({ text: "Hello stream" }, current)).resolves.toMatchObject({
      translatedText: "你好",
      cached: false,
    });
    expect(current.emit.mock.calls.map(([, value]) => value)).toEqual([
      expect.objectContaining({ text: "你好", done: false }),
      expect.objectContaining({ text: "", done: true }),
    ]);
    await expect(translator.translate({ text: "Hello stream" }, context())).resolves.toMatchObject({
      translatedText: "你好",
      cached: true,
    });
    expect(fetchStream).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight stream without caching its partial result and permits retry", async () => {
    const fetchStream = vi.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'),
              );
              init.signal.addEventListener(
                "abort",
                () => controller.error(new Error("Controlled transport aborted")),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchStream);
    const current = context();
    const pending = translator.translate(
      { text: "Cancel then retry", requestId: "owned-cancel" },
      current,
    );
    const rejected = expect(pending).rejects.toThrow("Translation cancelled");
    await vi.waitFor(() =>
      expect(current.emit).toHaveBeenCalledWith(
        "translation-chunk",
        expect.objectContaining({ text: "部分", done: false }),
      ),
    );
    expect(translator.cancel("owned-cancel")).toMatchObject({ cancelled: true });
    await rejected;
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, "translation-cache.json"), "utf8")),
    ).toEqual([]);
    expect(current.emit.mock.calls.some(([, value]) => value.done)).toBe(false);

    fetchStream.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "完整重试结果" } }] })),
    );
    await expect(
      translator.translate({ text: "Cancel then retry" }, context()),
    ).resolves.toMatchObject({ translatedText: "完整重试结果", cached: false });
    expect(fetchStream).toHaveBeenCalledTimes(2);
  });
});
