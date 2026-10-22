import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { createGm } from "./gm.js";
import { ClientMessage } from "./protocol.js";
import { Room } from "./room.js";
import type { PlayerRecord } from "./store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const filePath = path.join(config.clientDir, urlPath === "/" ? "index.html" : urlPath);
  // 擋掉 ../ 之類跳出 client/ 的路徑
  if (!filePath.startsWith(config.clientDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      })
      .end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  serveStatic(req, res);
});

const room = new Room(createGm());
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

wss.on("connection", (ws: WebSocket) => {
  let player: PlayerRecord | undefined;
  let alive = true;
  let windowStart = Date.now();
  let windowCount = 0;

  const helloTimer = setTimeout(() => {
    if (!player) ws.close(4001, "hello timeout");
  }, config.helloTimeoutMs);

  ws.on("pong", () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - windowStart > config.rateWindowMs) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > config.rateMaxMessages) {
      room.send(ws, { type: "error", code: "rate_limited", message: "訊息太頻繁，請稍候" });
      return;
    }

    let parsed: ClientMessage;
    try {
      const result = ClientMessage.safeParse(JSON.parse(raw.toString()));
      if (!result.success) throw new Error("invalid");
      parsed = result.data;
    } catch {
      room.send(ws, { type: "error", code: "bad_message", message: "無法辨識的訊息" });
      return;
    }

    if (parsed.type === "hello") {
      if (player) return;
      player = authenticate(parsed.token);
      if (!player) {
        ws.close(4003, "invalid token");
        return;
      }
      clearTimeout(helloTimer);
      room.join(player, ws);
      return;
    }

    if (!player) {
      ws.close(4001, "hello required");
      return;
    }
    room.handle(player, ws, parsed);
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    if (player) room.leave(player, ws);
  });
});

server.listen(config.port, config.host, () => {
  console.log(`TRPG host listening on http://${config.host}:${config.port}`);
});
