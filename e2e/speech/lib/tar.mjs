// Streaming reader for .tar.gz archives (ustar/GNU), with no dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Calls `onEntry(name, size)` for every regular file. When it returns true the
 * entry's bytes are buffered and passed to `onData(name, buffer)`.
 */
export async function readTarGz(file, { onEntry, onData }) {
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  let pending = Buffer.alloc(0);
  let current; // { name, remaining, padding, chunks, keep }
  let longName;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (true) {
      if (current) {
        const take = Math.min(current.remaining, pending.length);
        if (current.keep && take > 0)
          current.chunks.push(pending.subarray(0, take));
        current.remaining -= take;
        pending = pending.subarray(take);
        if (current.remaining > 0) break;
        if (pending.length < current.padding) break;
        pending = pending.subarray(current.padding);
        if (current.longNameEntry) {
          longName = Buffer.concat(current.chunks)
            .toString('utf8')
            .replace(/\0.*$/s, '');
        } else if (current.keep) {
          onData(current.name, Buffer.concat(current.chunks));
        }
        current = undefined;
        continue;
      }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) continue;
      const field = (start, length) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .replace(/\0.*$/s, '');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = field(156, 1) || '0';
      const prefix = field(345, 155);
      let name =
        longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = undefined;
      const padding = (512 - (size % 512)) % 512;
      if (type === 'L') {
        current = {
          name,
          remaining: size,
          padding,
          chunks: [],
          keep: true,
          longNameEntry: true,
        };
        continue;
      }
      const keep =
        (type === '0' || type === '\0') && onEntry(name, size) === true;
      current = { name, remaining: size, padding, chunks: [], keep };
    }
  }
}
