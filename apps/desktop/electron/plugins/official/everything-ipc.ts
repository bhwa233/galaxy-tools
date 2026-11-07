import net from "node:net";

/**
 * Minimal Everything 1.5 SDK3 named-pipe client, ported from the framing in
 * voidtools/everything_sdk3 `src/Everything3.c` (MIT). Only the requests this
 * host needs are implemented: version, property-indexed check and a paged
 * search returning name/path/size/modified/attributes.
 *
 * Every message is `{ code: u32, size: u32 }` followed by `size` bytes. A
 * reply is one or more `100 OK_MORE_DATA` chunks ending with `200 OK`; any
 * other code is an error. One request is in flight per connection; closing
 * the socket abandons it (the server cancels work for a disconnected client).
 */

const COMMAND = {
  ipcPipeVersion: 0,
  majorVersion: 1,
  minorVersion: 2,
  revision: 3,
  buildNumber: 4,
  search: 7,
  isDbLoaded: 8,
  isPropertyIndexed: 9,
} as const;
const RESPONSE_OK_MORE_DATA = 100;
const RESPONSE_OK = 200;
const SEARCH_FLAG = {
  matchCase: 0x1,
  matchWholeWord: 0x2,
  matchPath: 0x4,
  regex: 0x8,
  /** size_t fields are 64-bit on both sides. */
  size64: 0x4000,
} as const;
const ITEM_FLAG_FOLDER = 0x01;

export const EverythingProperty = {
  name: 0,
  path: 1,
  size: 2,
  dateModified: 5,
  attributes: 8,
  runCount: 10,
  fullPath: 240,
  content: 416,
} as const;

/** Value types this client can decode; anything else is a protocol error. */
const VALUE = {
  byte: 1,
  word: 2,
  dword: 3,
  dwordFixedQ1K: 4,
  uint64: 5,
  pstring: 8,
  pstringMulti: 9,
  pstringStringRef: 10,
  sizeT: 11,
  pstringFolderRef: 14,
  pstringFileOrFolderRef: 15,
  dwordGetText: 17,
  wordGetText: 18,
  byteGetText: 20,
} as const;

/** Upper bound for one reply; inline pages are at most a few hundred rows. */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;

export class EverythingIpcError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-running"
      | "busy"
      | "timeout"
      | "cancelled"
      | "closed"
      | "protocol"
      | "server",
    readonly responseCode?: number,
  ) {
    super(message);
    this.name = "EverythingIpcError";
  }
}

/** Mirrors `_everything3_cat_escaped_instance_name_no_null_terminate`. */
export function everythingPipeName(instance?: string): string {
  const base = "\\\\.\\pipe\\Everything IPC";
  if (!instance) return base;
  const escaped = [...instance]
    .map((character) =>
      character === "%" || character === ":" || character === "\\"
        ? `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`
        : character,
    )
    .join("");
  return `${base} (${escaped})`;
}

export interface EverythingVersion {
  major: number;
  minor: number;
  revision: number;
  build: number;
}

export interface EverythingSearchRequest {
  text: string;
  offset: number;
  count: number;
  matchCase?: boolean;
  matchPath?: boolean;
  matchWholeWord?: boolean;
  regex?: boolean;
  sort?: { property: number; descending?: boolean }[];
  properties: number[];
}

export type EverythingValue = string | bigint | number | undefined;
export interface EverythingItem {
  folder: boolean;
  values: Map<number, EverythingValue>;
}
export interface EverythingSearchResult {
  folderCount: bigint;
  fileCount: bigint;
  offset: bigint;
  items: EverythingItem[];
}

function lenVlq(value: number): Buffer {
  if (value < 0xff) return Buffer.from([value]);
  if (value - 0xff < 0xffff) {
    const buffer = Buffer.alloc(3);
    buffer[0] = 0xff;
    buffer.writeUInt16LE(value - 0xff, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(7);
  buffer[0] = 0xff;
  buffer.writeUInt16LE(0xffff, 1);
  buffer.writeUInt32LE(value - 0xff - 0xffff, 3);
  return buffer;
}
function dword(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}
function uint64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

/** Serializes `_everything3_search_with_extra_flags` request packets. */
export function encodeSearchRequest(request: EverythingSearchRequest): Buffer {
  if (
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isSafeInteger(request.count) ||
    request.count < 0 ||
    request.count > 10_000 ||
    request.properties.length > 32 ||
    (request.sort?.length ?? 0) > 8
  )
    throw new EverythingIpcError("Invalid Everything search request", "protocol");
  const text = Buffer.from(request.text, "utf8");
  let flags = SEARCH_FLAG.size64;
  if (request.matchCase) flags |= SEARCH_FLAG.matchCase;
  if (request.matchWholeWord) flags |= SEARCH_FLAG.matchWholeWord;
  if (request.matchPath) flags |= SEARCH_FLAG.matchPath;
  if (request.regex) flags |= SEARCH_FLAG.regex;
  const sort = request.sort ?? [];
  return Buffer.concat([
    dword(flags),
    lenVlq(text.length),
    text,
    uint64(request.offset),
    uint64(request.count),
    lenVlq(sort.length),
    ...sort.flatMap((entry) => [dword(entry.property), dword(entry.descending ? 1 : 0)]),
    lenVlq(request.properties.length),
    ...request.properties.flatMap((property) => [dword(property), dword(0)]),
  ]);
}

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}
  private take(size: number): Buffer {
    if (this.offset + size > this.buffer.length)
      throw new EverythingIpcError("Everything reply is truncated", "protocol");
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  byte(): number {
    return this.take(1)[0];
  }
  word(): number {
    return this.take(2).readUInt16LE();
  }
  dword(): number {
    return this.take(4).readUInt32LE();
  }
  uint64(): bigint {
    return this.take(8).readBigUInt64LE();
  }
  sizeT(is64: boolean): bigint {
    return is64 ? this.uint64() : BigInt(this.dword());
  }
  lenVlq(): number {
    const first = this.byte();
    if (first < 0xff) return first;
    const second = this.word();
    if (second < 0xffff) return 0xff + second;
    const third = this.dword();
    if (third < 0xffffffff) return 0xff + 0xffff + third;
    throw new EverythingIpcError("Everything reply length is out of range", "protocol");
  }
  utf8(length: number): string {
    return this.take(length).toString("utf8");
  }
  get remaining(): number {
    return this.buffer.length - this.offset;
  }
}

/** Parses a SEARCH reply payload (all chunks concatenated). */
export function decodeSearchReply(payload: Buffer, requestedCount: number): EverythingSearchResult {
  const reader = new Reader(payload);
  const validFlags = reader.dword();
  const is64 = (validFlags & SEARCH_FLAG.size64) !== 0;
  const folderCount = reader.sizeT(is64);
  const fileCount = reader.sizeT(is64);
  // TOTAL_SIZE (0x800) is never requested, so no total size follows.
  if (validFlags & 0x800) reader.uint64();
  const offset = reader.sizeT(is64);
  const viewportCount = reader.sizeT(is64);
  if (viewportCount > BigInt(requestedCount))
    throw new EverythingIpcError("Everything returned more rows than requested", "protocol");
  const sortCount = reader.lenVlq();
  for (let index = 0; index < sortCount; index++) {
    reader.dword();
    reader.dword();
  }
  const propertyCount = reader.lenVlq();
  if (propertyCount > 64)
    throw new EverythingIpcError("Everything returned too many properties", "protocol");
  const properties: { id: number; flags: number; type: number }[] = [];
  for (let index = 0; index < propertyCount; index++)
    properties.push({ id: reader.dword(), flags: reader.dword(), type: reader.byte() });
  const items: EverythingItem[] = [];
  for (let row = 0; row < Number(viewportCount); row++) {
    const flags = reader.byte();
    const values = new Map<number, EverythingValue>();
    for (const property of properties) {
      // FORMAT / HIGHLIGHT requests arrive as text regardless of the type.
      if (property.flags & 0x3) {
        const length = reader.lenVlq();
        values.set(property.id, length ? reader.utf8(length) : undefined);
        continue;
      }
      switch (property.type) {
        case VALUE.pstring:
        case VALUE.pstringMulti:
        case VALUE.pstringStringRef:
        case VALUE.pstringFolderRef:
        case VALUE.pstringFileOrFolderRef: {
          const length = reader.lenVlq();
          values.set(property.id, length ? reader.utf8(length) : undefined);
          break;
        }
        case VALUE.byte:
        case VALUE.byteGetText:
          values.set(property.id, reader.byte());
          break;
        case VALUE.word:
        case VALUE.wordGetText:
          values.set(property.id, reader.word());
          break;
        case VALUE.dword:
        case VALUE.dwordFixedQ1K:
        case VALUE.dwordGetText:
          values.set(property.id, reader.dword());
          break;
        case VALUE.uint64:
          values.set(property.id, reader.uint64());
          break;
        case VALUE.sizeT:
          values.set(property.id, reader.sizeT(is64));
          break;
        default:
          throw new EverythingIpcError(
            `Unsupported Everything property type ${property.type}`,
            "protocol",
          );
      }
    }
    items.push({ folder: (flags & ITEM_FLAG_FOLDER) !== 0, values });
  }
  if (reader.remaining)
    throw new EverythingIpcError("Everything reply has trailing data", "protocol");
  return { folderCount, fileCount, offset, items };
}

export interface EverythingConnectOptions {
  instance?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; production always derives the pipe from the instance name. */
  pipePath?: string;
}

/** One request at a time over one pipe connection. */
export class EverythingClient {
  private buffer: Buffer = Buffer.alloc(0);
  private waiter?: () => void;
  private failure?: EverythingIpcError;
  private busy = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.wake();
    });
    const closed = (error?: Error) => {
      this.failure ??= new EverythingIpcError(
        error?.message ?? "Everything closed the IPC pipe",
        "closed",
      );
      this.wake();
    };
    socket.on("error", closed);
    socket.on("close", () => closed());
  }

  static connect(options: EverythingConnectOptions = {}): Promise<EverythingClient> {
    const path = options.pipePath ?? everythingPipeName(options.instance);
    const timeoutMs = options.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted)
        return reject(new EverythingIpcError("Everything query cancelled", "cancelled"));
      const socket = net.connect({ path });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new EverythingIpcError("Everything IPC connection timed out", "timeout"));
      }, timeoutMs);
      const abort = () => {
        socket.destroy();
        reject(new EverythingIpcError("Everything query cancelled", "cancelled"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      socket.once("connect", () => {
        cleanup();
        socket.removeAllListeners("error");
        resolve(new EverythingClient(socket, timeoutMs));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        socket.destroy();
        reject(
          new EverythingIpcError(
            error.message,
            error.code === "ENOENT" ? "not-running" : error.code === "EBUSY" ? "busy" : "closed",
          ),
        );
      });
    });
  }

  close(): void {
    this.failure ??= new EverythingIpcError("Everything IPC client closed", "closed");
    this.socket.destroy();
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  private async read(size: number, deadline: number, signal?: AbortSignal): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure;
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new EverythingIpcError("Everything IPC timed out", "timeout");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        const abort = () => resolve();
        signal?.addEventListener("abort", abort, { once: true });
        this.waiter = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
      });
      this.waiter = undefined;
    }
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }

  /** Sends one command and collects every reply chunk up to `200 OK`. */
  async request(code: number, payload: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (this.busy) throw new EverythingIpcError("Everything IPC request already pending", "busy");
    this.busy = true;
    const abort = () => this.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.failure) throw this.failure;
      signal?.throwIfAborted();
      const header = Buffer.alloc(8);
      header.writeUInt32LE(code, 0);
      header.writeUInt32LE(payload.length, 4);
      this.socket.write(Buffer.concat([header, payload]));
      const deadline = Date.now() + this.timeoutMs;
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const reply = await this.read(8, deadline, signal);
        const responseCode = reply.readUInt32LE(0);
        const size = reply.readUInt32LE(4);
        total += size;
        if (total > MAX_REPLY_BYTES)
          throw new EverythingIpcError("Everything reply exceeds the size limit", "protocol");
        const data = size ? Buffer.from(await this.read(size, deadline, signal)) : Buffer.alloc(0);
        if (responseCode !== RESPONSE_OK && responseCode !== RESPONSE_OK_MORE_DATA)
          throw new EverythingIpcError(
            `Everything returned error ${responseCode}`,
            responseCode === 401 ? "cancelled" : "server",
            responseCode,
          );
        chunks.push(data);
        if (responseCode === RESPONSE_OK) return Buffer.concat(chunks);
      }
    } catch (error) {
      if (signal?.aborted) {
        this.close();
        throw new EverythingIpcError("Everything query cancelled", "cancelled");
      }
      // A half-read reply leaves the stream unusable.
      this.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.busy = false;
    }
  }

  private async dwordCommand(code: number, payload: Buffer = Buffer.alloc(0)): Promise<number> {
    const reply = await this.request(code, payload);
    if (reply.length !== 4) throw new EverythingIpcError("Unexpected Everything reply", "protocol");
    return reply.readUInt32LE();
  }

  async version(): Promise<EverythingVersion> {
    return {
      major: await this.dwordCommand(COMMAND.majorVersion),
      minor: await this.dwordCommand(COMMAND.minorVersion),
      revision: await this.dwordCommand(COMMAND.revision),
      build: await this.dwordCommand(COMMAND.buildNumber),
    };
  }

  async isDbLoaded(): Promise<boolean> {
    return (await this.dwordCommand(COMMAND.isDbLoaded)) !== 0;
  }

  async isPropertyIndexed(property: number): Promise<boolean> {
    return (await this.dwordCommand(COMMAND.isPropertyIndexed, dword(property))) !== 0;
  }

  async search(
    request: EverythingSearchRequest,
    signal?: AbortSignal,
  ): Promise<EverythingSearchResult> {
    const reply = await this.request(COMMAND.search, encodeSearchRequest(request), signal);
    return decodeSearchReply(reply, request.count);
  }
}

/** Versions 1.5 and later expose SDK3; anything older is not used. */
export function isSupportedEverythingVersion(version: EverythingVersion): boolean {
  return version.major > 1 || (version.major === 1 && version.minor >= 5);
}
