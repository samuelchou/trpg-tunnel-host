import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { GmError, type Gm } from "./gm.js";
import type { ToolSink } from "./tools.js";
import type {
  ClientMessage,
  GameEvent,
  HostStatus,
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
  type Role,
} from "./store.js";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

interface PendingAction {
  from: PlayerRef;
  text: string;
  private: boolean;
}

/** 一個伺服器 = 一場團。同一位玩家可以開多個分頁，所以每人對應一組連線 */
export class Room {
  private connections = new Map<string, Set<WebSocket>>();
  /** 在線玩家的身分，用來判斷誰看得到私密事件 */
  private roles = new Map<string, Role>();
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
  /** 上一次失敗或被中斷的回合；重試時要提醒 GM 以新訊息為準 */
  private interruptedRound: number | null = null;

  constructor(private gm: Gm) {}

  join(player: PlayerRecord, ws: WebSocket) {
    const firstConnection = !this.connections.has(player.id);
    let set = this.connections.get(player.id);
    if (!set) this.connections.set(player.id, (set = new Set()));
    set.add(ws);
    this.roles.set(player.id, player.role);

    this.send(ws, {
      type: "snapshot",
      you: { id: player.id, name: player.name, role: player.role },
      players: this.presence(),
      events: this.recent.filter((e) => this.canSee(player.id, e)),
      round: this.roundStatus(),
      yourAction: this.myAction(player.id),
      gmPartial: this.gmRound !== null ? this.gmPartial : null,
    });
    if (player.role === "host") this.send(ws, { type: "host_status", status: this.hostStatus() });
    if (firstConnection) this.broadcast({ type: "presence", players: this.presence() });
  }

  leave(player: PlayerRecord, ws: WebSocket) {
    const set = this.connections.get(player.id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.connections.delete(player.id);
      this.roles.delete(player.id);
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
        this.pending.set(player.id, { from: ref, text: msg.text, private: msg.private ?? false });
        this.autoResolveBlocked = false;
        this.sendTo(player.id, { type: "your_action", action: this.myAction(player.id) });
        this.broadcastRound();
        this.maybeAutoResolve();
        break;

      case "withdraw":
        if (!this.pending.delete(player.id)) return;
        this.autoResolveBlocked = false;
        this.sendTo(player.id, { type: "your_action", action: null });
        this.broadcastRound();
        break;

      default:
        if (player.role !== "host") {
          return this.send(ws, { type: "error", code: "forbidden", message: "只有主持人可以這樣做" });
        }
        this.handleHost(ws, msg);
    }
  }

  private handleHost(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "resolve_round" | "gm_note" | "clear_notes" | "pause" | "unpause" | "abort" }>,
  ) {
    const error = (code: string, message: string) => this.send(ws, { type: "error", code, message });
    switch (msg.type) {
      case "resolve_round":
        if (this.gmRound !== null) return error("gm_busy", "GM 還在回應上一回合");
        if (this.state.paused) return error("paused", "目前是暫停狀態，請先按「繼續」");
        if (this.pending.size === 0 && this.notes().length === 0) {
          return error("no_actions", "還沒有人送出行動，也沒有主持人指示");
        }
        this.resolve();
        break;

      case "gm_note":
        this.state.hostNotes = [...this.notes(), msg.text];
        saveState(this.state);
        this.record({ kind: "host_note", text: msg.text, visibleTo: [] });
        this.broadcastHostStatus();
        break;

      case "clear_notes":
        if (this.notes().length === 0) return;
        this.state.hostNotes = [];
        saveState(this.state);
        this.record({ kind: "system", text: "主持人清除了尚未送出的指示", visibleTo: [] });
        this.broadcastHostStatus();
        break;

      case "pause":
      case "unpause": {
        const paused = msg.type === "pause";
        if (!!this.state.paused === paused) return;
        this.state.paused = paused;
        saveState(this.state);
        this.record({
          kind: "system",
          text: paused ? "主持人暫停了遊戲，回合暫時不會結算" : "主持人恢復了遊戲",
        });
        this.broadcastRound();
        this.broadcastHostStatus();
        if (!paused) {
          this.autoResolveBlocked = false;
          this.maybeAutoResolve();
        }
        break;
      }

      case "abort":
        if (!this.gmAbort) return error("gm_idle", "GM 目前沒有在回應");
        this.gmAbort.abort();
        break;
    }
  }

  /** 所有在線玩家（不含主持人）都送出行動時自動結算 */
  private maybeAutoResolve() {
    if (this.gmRound !== null || this.state.paused || this.autoResolveBlocked || this.pending.size === 0) return;
    const required = loadPlayers().filter((p) => p.role === "player" && this.connections.has(p.id));
    if (required.length > 0 && required.every((p) => this.pending.has(p.id))) this.resolve();
  }

  private resolve() {
    const round = this.state.round;
    const actions = [...this.pending.values()];
    const notes = this.notes();
    this.pending.clear();
    this.state.hostNotes = [];
    for (const a of actions) {
      this.sendTo(a.from.id, { type: "your_action", action: null });
      this.record({
        kind: "action",
        round,
        from: a.from,
        text: a.text,
        ...(a.private && { private: true, visibleTo: [a.from.id] }),
      });
    }

    this.state.round = round + 1;
    saveState(this.state);
    this.gmRound = round;
    this.gmPartial = "";
    const abort = (this.gmAbort = new AbortController());
    this.broadcastRound();
    this.broadcastHostStatus();

    const retrying = this.interruptedRound === round;
    this.interruptedRound = null;
    const prompt = [
      ...(retrying ? ["（上一則同回合訊息的回應被中斷了，請忽略它，以這則為準重新回應。）"] : []),
      `【回合 ${round}】`,
      ...actions.map((a) => `- ${a.private ? "【私密】" : ""}${a.from.name}：${a.text}`),
      ...(actions.length === 0 ? ["（這回合沒有玩家行動）"] : []),
      ...notes.map((n) => `【主持人指示】${n}`),
    ].join("\n");

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
          tools: this.toolSink(round),
        },
        abort,
      )
      .then((result) => {
        this.updateCost(result.sessionCostUsd);
        this.record({ kind: "gm", round, text: result.text });
      })
      .catch((err: unknown) => {
        const partial = err instanceof GmError ? err.partial : undefined;
        this.updateCost(partial?.sessionCostUsd);
        // 失敗回合的半段敘事不寫進紀錄（client 會把已串流的部分標成中斷）
        if (abort.signal.aborted) {
          this.record({
            kind: "system",
            text: `主持人中斷了回合 ${round} 的 GM 回應。行動已退回，修改行動或由主持人重新結算即可重來。`,
          });
        } else {
          console.error(`[gm] 回合 ${round} 失敗：`, err);
          this.record({
            kind: "system",
            text: `GM 回應失敗（${err instanceof Error ? err.message : String(err)}）。行動已退回，修改行動或由主持人重新結算即可重試。`,
          });
        }
        // 退回行動；失敗的回合編號讓下一次重試沿用
        for (const a of actions) {
          if (!this.pending.has(a.from.id)) {
            this.pending.set(a.from.id, a);
            this.sendTo(a.from.id, { type: "your_action", action: this.myAction(a.from.id) });
          }
        }
        // 主持人指示也退回，排在回應期間新加的指示前面
        this.state.hostNotes = [...notes, ...this.notes()];
        this.state.round = round;
        saveState(this.state);
        this.autoResolveBlocked = true;
        this.interruptedRound = round;
      })
      .finally(() => {
        this.gmRound = null;
        this.gmPartial = "";
        this.gmAbort = undefined;
        this.broadcastRound();
        this.broadcastHostStatus();
        // GM 回應期間大家送出的行動，可能已經湊齊下一回合
        this.maybeAutoResolve();
      });
  }

  /** GM 工具在這一回合產生的擲骰與私訊 */
  private toolSink(round: number): ToolSink {
    const findPlayer = (name: string) => loadPlayers().find((p) => p.name === name);
    return {
      playerNames: () => loadPlayers().map((p) => p.name),
      onDice: (roll, reason, playerName) => {
        const target = playerName ? findPlayer(playerName) : undefined;
        this.record({
          kind: "dice",
          round,
          reason,
          notation: roll.notation,
          terms: roll.terms.map(({ label, rolls, value }) => ({ label, rolls, value })),
          total: roll.total,
          ...(target && { to: { id: target.id, name: target.name }, visibleTo: [target.id] }),
        });
      },
      onPrivate: (playerName, text) => {
        const target = findPlayer(playerName);
        if (!target) return false;
        this.record({
          kind: "private",
          round,
          to: { id: target.id, name: target.name },
          text,
          visibleTo: [target.id],
        });
        return true;
      },
    };
  }

  private notes() {
    return this.state.hostNotes ?? [];
  }

  private hostStatus(): HostStatus {
    return {
      notes: this.notes(),
      totalCostUsd: this.state.totalCostUsd,
      sessionId: this.state.sessionId ?? null,
      model: config.gm.model,
      effort: config.gm.effort,
      mock: config.gm.mock,
    };
  }

  private broadcastHostStatus() {
    const msg: ServerMessage = { type: "host_status", status: this.hostStatus() };
    for (const [playerId, role] of this.roles) if (role === "host") this.sendTo(playerId, msg);
  }

  private myAction(playerId: string) {
    const a = this.pending.get(playerId);
    return a ? { text: a.text, private: a.private } : null;
  }

  /** 主持人看得到所有私密事件 */
  private canSee(playerId: string, event: GameEvent) {
    return !event.visibleTo || event.visibleTo.includes(playerId) || this.roles.get(playerId) === "host";
  }

  private updateCost(sessionCostUsd: number | undefined) {
    if (sessionCostUsd === undefined) return;
    this.state.totalCostUsd = Math.max(this.state.totalCostUsd, sessionCostUsd);
    saveState(this.state);
    this.broadcastHostStatus();
  }

  private record(body: DistributiveOmit<GameEvent, "id" | "ts">) {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...body } as GameEvent;
    appendEvent(event);
    this.recent.push(event);
    if (this.recent.length > config.historyLimit) this.recent.shift();
    const data = JSON.stringify({ type: "event", event } satisfies ServerMessage);
    for (const [playerId, set] of this.connections) {
      if (!this.canSee(playerId, event)) continue;
      for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private roundStatus(): RoundStatus {
    return {
      round: this.state.round,
      submitted: [...this.pending.keys()],
      gmRound: this.gmRound,
      paused: !!this.state.paused,
    };
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
