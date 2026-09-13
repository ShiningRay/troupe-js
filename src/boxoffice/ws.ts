import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";

/**
 * 零依赖 WebSocket（RFC 6455 最小实现，M8 BoxOffice 用）：
 * - 服务端握手（Sec-WebSocket-Accept）+ 文本帧收发 + ping/pong + close
 * - 客户端帧必须 mask（协议要求），分片（continuation）支持
 * - 不支持二进制/扩展（BoxOffice 仅 JSON 文本）
 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1024 * 1024;

export class WsConnection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  closed = false;

  private messageHandler: ((text: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(readonly socket: Socket, head: Buffer) {
    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
    if (head.length > 0) this.feed(head);
  }

  /** 绑定消息/关闭处理器（attach 后由调用方设置） */
  bind(onMessage: (text: string) => void, onClose: () => void): void {
    this.messageHandler = onMessage;
    this.closeHandler = onClose;
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.parseFrame();
      if (!frame) return;
      const { opcode, payload } = frame;
      if (opcode === 0x8) {
        // close：回 close 帧并断开
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        this.handleClose();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload); // ping → pong
        continue;
      }
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x1 || opcode === 0x2) {
        if (!frame.fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          continue;
        }
        this.deliver(payload);
        continue;
      }
      if (opcode === 0x0) {
        // continuation
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        if (total > MAX_MESSAGE) {
          this.close(1009);
          return;
        }
        if (frame.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === 0x1) this.deliver(full);
        }
        continue;
      }
    }
  }

  private deliver(payload: Buffer): void {
    if (payload.length > MAX_MESSAGE) {
      this.close(1009);
      return;
    }
    this.messageHandler?.(payload.toString("utf8"));
  }

  /** 解析一帧；数据不足返回 null。客户端帧必须 mask。 */
  private parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head: Buffer;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65_536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  sendText(text: string): void {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(code = 1000): void {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.sendFrame(0x8, body);
    this.socket.end();
    this.handleClose();
  }
}

export interface WsAttachOptions {
  path: string;
  /** 升级前鉴权（BoxOffice ticket）；拒绝时返回 401 */
  authorize?(req: IncomingMessage): boolean;
  onConnection(conn: WsConnection, req: IncomingMessage): void;
}

/** 把 WS 升级处理挂到 HTTP server（同一端口复用，BoxOffice 页面 + WS） */
export function attachWebSocket(server: Server, opts: WsAttachOptions): void {
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    const sock = socket as Socket;
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname !== opts.path || req.headers.upgrade?.toLowerCase() !== "websocket") {
        sock.destroy();
        return;
      }
      if (opts.authorize && !opts.authorize(req)) {
        sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        sock.destroy();
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (!key || (req.headers["sec-websocket-version"] ?? "") !== "13") {
        sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        sock.destroy();
        return;
      }
      const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const conn = new WsConnection(sock, head);
      opts.onConnection(conn, req);
    } catch {
      sock.destroy();
    }
  });
}

export type { ServerResponse };
