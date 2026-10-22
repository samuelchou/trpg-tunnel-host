import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { GmError, type Gm } from "./gm.js";
import type {
  ClientMessage,
  GameEvent,
  PlayerPresence,
  PlayerRef,
  RoundStatus,
  ServerMessage,
} from "./protocol.js";
import {
  appendEvent,
  loadPlayers,
  loadRecentEvents,
  loadState,
  saveState,
  type PlayerRecord,
} from "./store.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

interface PendingAction {
  from: PlayerRef;
  text: string;
}

/** 一個伺服器 = 一場團。同一位玩家可以開多個分頁，所以每人對應一組連線 */
export class Room {
  private connections = new Map<string, Set<WebSocket>>();
  private recent: GameEvent[] = loadRecentEvents(config.historyLimit);
  private state = loadState();

  /** 本回合已送出的行動，依送出順序 */
  private pending = new Map<string, PendingAction>();
  /** GM 正在回應的回合 */
  private gmRound: number | null = null;
  private gmPartial = "";
  private gmAbort?: AbortController;
  /** GM 失敗後先別自動重試，等有人改動行動或 host 手動結算 */
  private autoResolveBlocked = false;

  constructor(private gm: Gm) {}

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
      round: this.roundStatus(),
      yourAction: this.pending.get(player.id)?.text ?? null,
      gmPartial: this.gmRound !== null ? this.gmPartial : null,
    });
    if (firstConnection) this.broadcast({ type: "presence", players: this.presence() });
  }

  leave(player: PlayerRecord, ws: WebSocket) {
    const set = this.connections.get(player.id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.connections.delete(player.id);
      this.broadcast({ type: "presence", players: this.presence() });
      // 剩下的人可能都已經行動了
      this.maybeAutoResolve();
    }
  }

  handle(player: PlayerRecord, ws: WebSocket, msg: Exclude<ClientMessage, { type: "hello" }>) {
    const ref = { id: player.id, name: player.name };
    switch (msg.type) {
      case "chat":
        this.record({ kind: "chat", from: ref, text: msg.text });
        break;

      case "action":
        this.pending.set(player.id, { from: ref, text: msg.text });
        this.autoResolveBlocked = false;
        this.sendTo(player.id, { type: "your_action", text: msg.text });
        this.broadcastRound();
        this.maybeAutoResolve();
        break;

      case "withdraw":
        if (!this.pending.delete(player.id)) return;
        this.autoResolveBlocked = false;
        this.sendTo(player.id, { type: "your_action", text: null });
        this.broadcastRound();
        break;

      case "resolve_round":
        if (player.role !== "host") {
          return this.send(ws, { type: "error", code: "forbidden", message: "只有主持人可以結算回合" });
        }
        if (this.gmRound !== null) {
          return this.send(ws, { type: "error", code: "gm_busy", message: "GM 還在回應上一回合" });
        }
        if (this.pending.size === 0) {
          return this.send(ws, { type: "error", code: "no_actions", message: "還沒有人送出行動" });
        }
        this.resolve();
        break;
    }
  }

  /** 所有在線玩家（不含主持人）都送出行動時自動結算 */
  private maybeAutoResolve() {
    if (this.gmRound !== null || this.autoResolveBlocked || this.pending.size === 0) return;
    const required = loadPlayers().filter((p) => p.role === "player" && this.connections.has(p.id));
    if (required.length > 0 && required.every((p) => this.pending.has(p.id))) this.resolve();
  }

  private resolve() {
    const round = this.state.round;
    const actions = [...this.pending.values()];
    this.pending.clear();
    for (const a of actions) {
      this.sendTo(a.from.id, { type: "your_action", text: null });
      this.record({ kind: "action", round, from: a.from, text: a.text });
    }

    this.state.round = round + 1;
    saveState(this.state);
    this.gmRound = round;
    this.gmPartial = "";
    this.gmAbort = new AbortController();
    this.broadcastRound();

    const prompt = [`【回合 ${round}】`, ...actions.map((a) => `- ${a.from.name}：${a.text}`)].join("\n");

    this.gm
      .run(
        prompt,
        this.state.sessionId,
        {
          onText: (delta) => {
            this.gmPartial += delta;
            this.broadcast({ type: "gm_delta", round, text: delta });
          },
          onSessionId: (sessionId) => {
            this.state.sessionId = sessionId;
            saveState(this.state);
          },
        },
        this.gmAbort,
      )
      .then((result) => {
        this.updateCost(result.sessionCostUsd);
        this.record({ kind: "gm", round, text: result.text });
      })
      .catch((err: unknown) => {
        const partial = err instanceof GmError ? err.partial : undefined;
        this.updateCost(partial?.sessionCostUsd);
        console.error(`[gm] 回合 ${round} 失敗：`, err);
        // 失敗回合的半段敘事不寫進紀錄（client 會把已串流的部分標成中斷）
        this.record({
          kind: "system",
          text: `GM 回應失敗（${err instanceof Error ? err.message : String(err)}）。行動已退回，修改行動或由主持人重新結算即可重試。`,
        });
        // 退回行動；失敗的回合編號讓下一次重試沿用
        for (const a of actions) {
          if (!this.pending.has(a.from.id)) {
            this.pending.set(a.from.id, a);
            this.sendTo(a.from.id, { type: "your_action", text: a.text });
          }
        }
        this.state.round = round;
        saveState(this.state);
        this.autoResolveBlocked = true;
      })
      .finally(() => {
        this.gmRound = null;
        this.gmPartial = "";
        this.gmAbort = undefined;
        this.broadcastRound();
        // GM 回應期間大家送出的行動，可能已經湊齊下一回合
        this.maybeAutoResolve();
      });
  }

  private updateCost(sessionCostUsd: number | undefined) {
    if (sessionCostUsd === undefined) return;
    this.state.totalCostUsd = Math.max(this.state.totalCostUsd, sessionCostUsd);
    saveState(this.state);
  }

  private record(body: DistributiveOmit<GameEvent, "id" | "ts">) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...body } as GameEvent;
    appendEvent(event);
    this.recent.push(event);
    if (this.recent.length > config.historyLimit) this.recent.shift();
    this.broadcast({ type: "event", event });
  }

  private roundStatus(): RoundStatus {
    return { round: this.state.round, submitted: [...this.pending.keys()], gmRound: this.gmRound };
  }

  private broadcastRound() {
    this.broadcast({ type: "round_status", round: this.roundStatus() });
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

  private sendTo(playerId: string, msg: ServerMessage) {
    for (const ws of this.connections.get(playerId) ?? []) this.send(ws, msg);
  }

  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
