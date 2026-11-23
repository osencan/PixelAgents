import * as fs from 'node:fs/promises';

import type { ObservedSession, SessionReader } from './observer.js';

/** Bytes read per chunk. */
const CHUNK_BYTES = 256 * 1024;
/** An unterminated line longer than this is dropped rather than buffered. */
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/**
 * Follows an append-only JSONL log from a byte offset: partial lines and
 * split UTF-8 wait for the rest, malformed lines are skipped, and a replaced
 * (new inode) or truncated file starts over with a fresh session.
 */
export class JsonlTail<S extends ObservedSession> implements SessionReader {
  offset = 0;
  pending = Buffer.alloc(0);
  session: S;
  private inode = 0;
  constructor(
    private readonly fresh: () => S,
    private readonly reduce: (session: S, record: unknown) => void,
  ) {
    this.session = fresh();
  }
  async read(file: string): Promise<void> {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if ((this.inode && stat.ino !== this.inode) || stat.size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.session = this.fresh();
      }
      this.inode = stat.ino;
      // Fixed snapshot prevents a busy session from holding this poll open forever.
      const end = stat.size;
      while (this.offset < end) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let start = 0,
          newline: number;
        while ((newline = data.indexOf(10, start)) !== -1) {
          try {
            this.reduce(this.session, JSON.parse(data.subarray(start, newline).toString('utf8')));
          } catch {
            /* A malformed line must not break subsequent events. */
          }
          start = newline + 1;
        }
        this.pending = Buffer.from(data.subarray(start));
        if (this.pending.length > MAX_PENDING_BYTES) this.pending = Buffer.alloc(0);
      }
    } finally {
      await handle.close();
    }
  }
}
