// Raw TCP HTTP/1.1 transport for the forge — a drop-in replacement for
// node:http's createServer, keeping the exact same request handler.
//
// Why: the suite's timed workloads are transport-bound (the handler is ~0.02 ms
// of a ~0.4 ms op; the rest is Node's HTTP parser + IncomingMessage/
// ServerResponse allocation + the client's fetch). A minimal parser that only
// does what the suite's clients need (undici fetch: GET/POST/PUT/PATCH/DELETE,
// Content-Length or chunked bodies, keep-alive, no Expect) cuts the
// per-request server cost measurably. Anything the suite does not send is still
// handled defensively.
//
// The handler sees shim objects shaped like IncomingMessage/ServerResponse for
// exactly the surface app.ts uses: req.method, req.url, req.headers (lowercased),
// req.on('data'|'end'|'error'), res.writeHead, res.end, res.headersSent.
// Responses are written as one buffer (head + body) per request, in request
// order per connection (a FIFO chain; undici never pipelines, so depth is 1).

import net from 'node:net';
import { STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;
const DISPATCH_TIMEOUT_MS = 30_000;

/** The request listener, typed exactly like node:http's — the shim req/res are
 * cast to these types at the call site (transport.ts is the only place that
 * knows they are shims). */
type Listener = (req: IncomingMessage, res: ServerResponse) => void;

class ShimRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private body: Buffer;
  private delivered = false;

  constructor(method: string, url: string, headers: Record<string, string>, body: Buffer) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  /** app.ts's readBody attaches 'data' then 'end'; deliver the buffered body lazily
   * on the first 'data' subscription so nothing is lost to an unattached listener. */
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener as (...args: never[]) => void);
    if (event === 'data' && !this.delivered) {
      this.delivered = true;
      queueMicrotask(() => {
        if (this.body.length > 0) this.emit('data', this.body);
        this.emit('end');
      });
    }
    return this;
  }

  destroy(): void {
    this.emit('error', new Error('request aborted'));
  }
}

class ShimResponse extends EventEmitter {
  headersSent = false;
  private status = 200;
  private head = '';
  private ended = false;
  private onFinished: (() => void) | null = null;
  readonly finished: Promise<void>;

  constructor() {
    super();
    this.finished = new Promise<void>((resolve) => {
      this.onFinished = resolve;
    });
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headersSent = true;
    const lines: string[] = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    this.head = `${lines.join('\r\n')}\r\n\r\n`;
    return this;
  }

  end(chunk?: string | Buffer): this {
    if (this.ended) return this;
    this.ended = true;
    if (!this.headersSent) this.writeHead(this.status, {});
    const body = chunk === undefined ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.emit('bytes', Buffer.concat([Buffer.from(this.head, 'latin1'), body]));
    this.onFinished?.();
    return this;
  }
}

interface PendingRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  head: boolean;
  httpMinor: number;
}

function parseHeaders(head: string): { method: string; url: string; headers: Record<string, string>; httpMinor: number } | null {
  const lines = head.split('\r\n');
  const first = lines[0] ?? '';
  const sp1 = first.indexOf(' ');
  const sp2 = first.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) return null;
  const method = first.slice(0, sp1);
  const url = first.slice(sp1 + 1, sp2);
  const version = first.slice(sp2 + 1);
  const minor = version === 'HTTP/1.0' ? 0 : 1;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c < 0) continue;
    const name = lines[i].slice(0, c).trim().toLowerCase();
    const value = lines[i].slice(c + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { method, url, headers, httpMinor: minor };
}

/** Decode a chunked body starting at `start`: returns the de-chunked body and
 * the bytes consumed (headers' end through the terminating chunk's CRLF), null
 * when more bytes are needed, and throws on malformed framing. Trailers after
 * the terminating chunk are skipped. */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error('malformed chunk size');
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (buf.length < dataStart + size + 2) return null;
    if (size === 0) {
      // Terminating chunk: skip any trailers up to the blank line.
      let trailerEnd = dataStart;
      for (;;) {
        const end = buf.indexOf('\r\n', trailerEnd);
        if (end < 0) return null;
        if (end === trailerEnd) return { body: Buffer.concat(parts), consumed: end + 2 - start };
        trailerEnd = end + 2;
      }
    }
    parts.push(buf.subarray(dataStart, dataStart + size));
    if (buf.subarray(dataStart + size, dataStart + size + 2).toString('latin1') !== '\r\n') {
      throw new Error('malformed chunk terminator');
    }
    offset = dataStart + size + 2;
    if (parts.reduce((n, p) => n + p.length, 0) > MAX_BODY_BYTES) throw new Error('request body too large');
  }
}

/** Parse one complete request out of `buf` (or null when more bytes are needed).
 * Returns the request plus the remaining bytes. Bodies arrive either by
 * Content-Length or chunked transfer-encoding. */
function takeRequest(buf: Buffer): { req: PendingRequest; rest: Buffer } | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (buf.length > 65536) throw new Error('request head too large');
    return null;
  }
  const parsed = parseHeaders(buf.subarray(0, headerEnd).toString('latin1'));
  if (!parsed) throw new Error('malformed request line');
  const { method, url, headers, httpMinor } = parsed;
  const bodyStart = headerEnd + 4;
  let body: Buffer;
  let rest: Buffer;
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    const decoded = decodeChunked(buf, bodyStart);
    if (!decoded) return null;
    body = decoded.body;
    rest = buf.subarray(bodyStart + decoded.consumed);
  } else {
    const contentLength = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
      throw new Error('bad content-length');
    }
    if (buf.length < bodyStart + contentLength) return null;
    body = Buffer.from(buf.subarray(bodyStart, bodyStart + contentLength));
    rest = buf.subarray(bodyStart + contentLength);
  }
  return {
    req: { method, url, headers, body, head: method === 'HEAD', httpMinor },
    rest,
  };
}

class RawServer extends EventEmitter {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private listener: Listener;

  constructor(listener: Listener) {
    super();
    this.listener = listener;
    this.server = net.createServer((socket) => this.attach(socket));
    this.server.on('error', (err) => this.emit('error', err));
  }

  private attach(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buf = Buffer.alloc(0);
    // Responses are written strictly in request order per connection.
    let chain: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        let taken: { req: PendingRequest; rest: Buffer } | null;
        try {
          taken = takeRequest(buf);
        } catch {
          socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
          socket.end();
          return;
        }
        if (!taken) return;
        buf = taken.rest;
        const { req } = taken;
        chain = chain.then(() => this.dispatch(socket, req));
      }
    });
  }

  private async dispatch(socket: net.Socket, pending: PendingRequest): Promise<void> {
    if (socket.destroyed) return;
    const req = new ShimRequest(pending.method, pending.url, pending.headers, pending.body);
    const res = new ShimResponse();
    // HTTP/1.1 keeps alive unless `connection: close`; HTTP/1.0 closes unless
    // `connection: keep-alive` — the same rule Node's server applies.
    const conn = (pending.headers.connection ?? '').toLowerCase();
    const keepAlive = pending.httpMinor === 1 ? conn !== 'close' : conn === 'keep-alive';
    res.on('bytes', (bytes: Buffer) => {
      if (socket.destroyed) return;
      // HEAD answers carry headers only, like Node's server.
      if (pending.head) {
        const headEnd = bytes.indexOf('\r\n\r\n');
        socket.write(bytes.subarray(0, headEnd + 4));
      } else {
        socket.write(bytes);
      }
      if (!keepAlive) socket.end();
    });
    const watchdog = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, DISPATCH_TIMEOUT_MS);
    watchdog.unref?.();
    try {
      this.listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      await res.finished;
    } catch {
      if (!res.headersSent && !socket.destroyed) {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': '29' });
          res.end('{"message":"Internal Error"}\n');
          await res.finished;
        } catch {
          // socket gone; nothing more to do
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }

  listen(port: number, cb?: () => void): this {
    this.server.listen(port, cb);
    return this;
  }

  address(): net.AddressInfo | string | null {
    return this.server.address();
  }

  close(cb?: () => void): this {
    for (const socket of this.sockets) socket.destroy();
    this.server.close(cb);
    return this;
  }
}

/** Same call shape as node:http's createServer: a request listener, back a server
 * with listen/address/close/once. The listener receives the shim req/res. The
 * returned object is the raw server cast to node:http's Server type so callers
 * (app.ts, main.ts) need no changes beyond the import. */
export function createServer(listener: Listener): Server {
  return new RawServer(listener) as unknown as Server;
}
