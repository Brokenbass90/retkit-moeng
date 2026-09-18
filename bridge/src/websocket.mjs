import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

function createParser({ onText, onClose, onError, sendRaw }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = Boolean(b0 & 0x80);
        const opcode = b0 & 0x0f;
        const masked = Boolean(b1 & 0x80);
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(16 * 1024 * 1024)) throw new Error('WebSocket frame too large');
          length = Number(big);
          offset = 10;
        }
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + length) return;
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + length);
        if (masked) {
          const key = buffer.subarray(offset, offset + 4);
          const copy = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i += 1) copy[i] = payload[i] ^ key[i % 4];
          payload = copy;
        }
        buffer = buffer.subarray(offset + maskBytes + length);

        if (opcode === 0x8) { onClose?.(); return; }
        if (opcode === 0x9) { sendRaw(encodeFrame(0xA, payload)); continue; }
        if (opcode === 0xA) continue;
        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            if (opcode === 0x1) onText?.(payload.toString('utf8'));
          } else {
            fragments = [payload];
            fragmentOpcode = opcode;
          }
          continue;
        }
        if (opcode === 0x0 && fragments.length) {
          fragments.push(payload);
          if (fin) {
            const whole = Buffer.concat(fragments);
            if (fragmentOpcode === 0x1) onText?.(whole.toString('utf8'));
            fragments = [];
            fragmentOpcode = 0;
          }
        }
      }
    } catch (error) {
      onError?.(error);
    }
  }
  return { feed };
}

export function acceptWebSocket(req, socket, head, handlers = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) throw new Error('Missing Sec-WebSocket-Key');
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));

  let closed = false;
  const sendRaw = (data) => { if (!closed && !socket.destroyed) socket.write(data); };
  const parser = createParser({
    onText: handlers.onMessage,
    onClose: () => { closed = true; try { socket.end(); } catch {} handlers.onClose?.(); },
    onError: (error) => { handlers.onError?.(error); try { socket.destroy(); } catch {} },
    sendRaw,
  });
  if (head?.length) parser.feed(head);
  socket.on('data', parser.feed);
  socket.on('close', () => { if (!closed) { closed = true; handlers.onClose?.(); } });
  socket.on('error', (error) => handlers.onError?.(error));

  return {
    send(value) { sendRaw(encodeFrame(0x1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))); },
    close() { if (closed) return; closed = true; try { sendRaw(encodeFrame(0x8)); socket.end(); } catch {} },
    get closed() { return closed; },
  };
}
