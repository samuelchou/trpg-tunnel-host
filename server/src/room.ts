import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import type { ClientMessage, GameEvent, PlayerPresence, ServerMessage } from "./protocol.js";
import { appendEvent, loadPlayers, loadRecentEvents, type PlayerRecord } from "./store.js";

/** 一個伺服器 = 一場團。同一位玩家可以開多個分頁，所以每人對應一組連線 */
export class Room {
  private connections = new Map<string, Set<WebSocket>>();
  private recent: GameEvent[] = loadRecentEvents(config.historyLimit);

  join(player: PlayerRecord, ws: WebSocket) {
    const firstConnection = !this.connections.has(player.id);
    let set = this.connections.get(player.id);
    if (!set) this.connections.set(player.id, (set = new Set()));
    set.add(ws);

    this.send(ws, {
      type: "snapshot",
      you: { id: player.id, name: player.name, role: player.role },
      players: this.presence(),
      events: this.recent,
    });
    if (firstConnection) {
      this.record({ ...this.meta(), kind: "system", text: `${player.name} 加入了` });
      this.broadcast({ type: "presence", players: this.presence() });
    }
  }

  leave(player: PlayerRecord, ws: WebSocket) {
    const set = this.connections.get(player.id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.connections.delete(player.id);
      this.record({ ...this.meta(), kind: "system", text: `${player.name} 離開了` });
      this.broadcast({ type: "presence", players: this.presence() });
    }
  }

  handle(player: PlayerRecord, msg: Exclude<ClientMessage, { type: "hello" }>) {
    switch (msg.type) {
      case "chat":
        this.record({
          ...this.meta(),
          kind: "chat",
          from: { id: player.id, name: player.name },
          text: msg.text,
        });
        break;
    }
  }

  private record(event: GameEvent) {
    appendEvent(event);
    this.recent.push(event);
    if (this.recent.length > config.historyLimit) this.recent.shift();
    this.broadcast({ type: "event", event });
  }

  private meta() {
    return { id: crypto.randomUUID(), ts: new Date().toISOString() };
  }

  private presence(): PlayerPresence[] {
    return loadPlayers().map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      online: this.connections.has(p.id),
    }));
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const set of this.connections.values()) {
      for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
