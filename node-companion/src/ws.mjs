// A minimal RFC 6455 server endpoint for the job event stream (SDK ADR-021):
// unmasked, unfragmented text frames from the server, each at most 65,535
// bytes, ping/pong, and close. Client frames must be masked and are only
// read for control purposes; the stream carries no client data.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_FRAME = 65_535;

/** Completes the upgrade, or answers 400 and returns null. */
export function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (
    req.method !== 'GET' ||
    (req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    Buffer.from(key, 'base64').length !== 16
  ) {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
    return null;
  }
  const acceptKey = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
  return new Connection(socket);
}

function frame(opcode, payload) {
  const length = payload.length;
  if (length > MAX_FRAME) throw new Error('frame over 65,535 bytes');
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

export class Connection {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.onClose = () => {};
    socket.on('data', chunk => this.read(chunk));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    this.onClose();
  }

  sendText(text) {
    if (!this.open) return false;
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    return true;
  }

  close(code = 1000) {
    if (!this.open) return;
    this.socket.write(frame(0x8, Buffer.from([code >> 8, code & 0xff])));
    this.socket.end();
    this.closed();
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let at = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        // Client frames are tiny control frames; a 64-bit length is abuse.
        this.socket.destroy();
        return;
      }
      if (!masked || length > 4096) {
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < at + 4 + length) return;
      const mask = this.buffer.subarray(at, at + 4);
      const payload = Buffer.from(
        this.buffer.subarray(at + 4, at + 4 + length),
      );
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(at + 4 + length);
      const opcode = b0 & 0x0f;
      if (opcode === 0x9 && this.open) this.socket.write(frame(0xa, payload));
      else if (opcode === 0x8) this.close(1000);
    }
  }
}
