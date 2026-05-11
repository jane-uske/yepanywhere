/**
 * JSONL file reading utilities.
 *
 * Shared helpers for reading JSONL session files with BOM handling
 * and partial reads (to avoid loading multi-MB files entirely).
 */

import { open, readFile } from "node:fs/promises";

/** Strip UTF-8 BOM if present (common on Windows). */
export function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

/**
 * Read the first line of a file using a partial read.
 * Reads in chunks until it finds a newline, reaches EOF, or hits maxBytes.
 * Returns null for empty files or empty first lines.
 */
export async function readFirstLine(
  filePath: string,
  maxBytes = 4096,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const chunkSize = Math.min(4096, maxBytes);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let content = "";

    while (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      const buf = Buffer.alloc(Math.min(chunkSize, remaining));
      const { bytesRead } = await fd.read(buf, 0, buf.length, totalBytes);
      if (bytesRead === 0) break;

      chunks.push(buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
      content = Buffer.concat(chunks).toString("utf-8");
      if (content.includes("\n")) break;
    }

    if (totalBytes === 0) return null;

    const stripped = stripBom(content);
    const nl = stripped.indexOf("\n");
    const line = (nl > 0 ? stripped.slice(0, nl) : stripped).trim();
    return line || null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

/**
 * Read a file and return BOM-stripped lines.
 */
export async function readJsonlLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf-8");
  return stripBom(raw).trim().split("\n");
}

export interface ReadJsonlTailLinesOptions {
  /** Number of boundary lines to include when reading from the end. */
  boundaryCount: number;
  /** Return true when a line is a logical boundary for the caller. */
  isBoundaryLine: (line: string) => boolean;
  /** Read chunk size for backward scanning. */
  chunkSize?: number;
}

export interface ReadJsonlTailLinesResult {
  lines: string[];
  truncated: boolean;
}

/**
 * Read a JSONL suffix from the end of a file, starting at the Nth boundary from
 * the end. This avoids parsing the entire file for "show me the latest chunk"
 * views of large session logs.
 */
export async function readJsonlTailLines(
  filePath: string,
  options: ReadJsonlTailLinesOptions,
): Promise<ReadJsonlTailLinesResult> {
  if (options.boundaryCount <= 0) {
    return { lines: await readJsonlLines(filePath), truncated: false };
  }

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const stats = await fd.stat();
    const chunkSize = options.chunkSize ?? 1024 * 1024;
    let position = stats.size;
    let content = Buffer.alloc(0);

    while (position > 0) {
      const readStart = Math.max(0, position - chunkSize);
      const length = position - readStart;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buf, 0, length, readStart);
      if (bytesRead === 0) break;

      content = Buffer.concat([buf.subarray(0, bytesRead), content]);
      position = readStart;

      const lines = stripBom(content.toString("utf-8"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      let seenBoundaries = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !options.isBoundaryLine(line)) continue;

        seenBoundaries++;
        if (seenBoundaries >= options.boundaryCount) {
          return {
            lines: lines.slice(i),
            truncated: i > 0 || readStart > 0,
          };
        }
      }
    }

    return {
      lines: stripBom(content.toString("utf-8"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      truncated: false,
    };
  } catch {
    return { lines: await readJsonlLines(filePath), truncated: false };
  } finally {
    await fd?.close();
  }
}
