import { Transform, type TransformCallback } from "node:stream";
import * as ssri from "ssri";

// npm-registry-fetch/tar provide transport and parsing. They do not impose our
// plugin resource budgets, so this stream only counts bytes at that boundary.
export function limitPackageBytes(maximum: number, label: string): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      received += chunk.length;
      if (received > maximum) callback(new Error(`${label} exceeds ${maximum} bytes`));
      else callback(null, chunk);
    },
  });
}

export function requirePackageIntegrity(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error("A plugin tarball requires a supported SRI integrity value");
  }
  const integrity = ssri.parse(value, { strict: true });
  if (
    !integrity ||
    !Object.keys(integrity).some((key) => ["sha256", "sha384", "sha512"].includes(key))
  ) {
    throw new Error("Plugin integrity must use SHA-256, SHA-384 or SHA-512");
  }
  return integrity.toString();
}

export function registryPackageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Plugin registry and tarball URLs must use HTTPS without embedded credentials");
  }
  return url;
}
