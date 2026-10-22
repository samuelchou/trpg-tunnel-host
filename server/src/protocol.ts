import { z } from "zod";
import { config } from "./config.js";
import type { Role } from "./store.js";

// ---- client → server ----

const text = z.string().trim().min(1).max(config.maxChatLength);

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().min(1).max(200) }),
  /** OOC 閒聊，不送 GM */
  z.object({ type: z.literal("chat"), text }),
  /** 本回合的角色行動；再送一次會覆蓋。private 為 true 時只有 GM（與主持人）看得到 */
  z.object({ type: z.literal("action"), text, private: z.boolean().optional() }),
  z.object({ type: z.literal("withdraw") }),
  // ---- 以下為 host 限定 ----
  /** 不等其他人，立即結算（沒有人行動也可以，只要有主持人指示） */
  z.object({ type: z.literal("resolve_round") }),
  /** 主持人指示：只有 GM 和主持人看得到，併入下一回合 */
  z.object({ type: z.literal("gm_note"), text }),
  z.object({ type: z.literal("clear_notes") }),
  /** 暫停後不會結算回合（玩家仍可送出行動） */
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("unpause") }),
  /** 中斷正在進行的 GM 回應，行動會退回 */
  z.object({ type: z.literal("abort") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- 事件（寫入 log.jsonl，重連時重播） ----

export interface PlayerRef {
  id: string;
  name: string;
}

interface EventMeta {
  id: string;
  ts: string;
  /** 只有這些玩家（以及主持人）看得到；沒有則所有人都看得到 */
  visibleTo?: string[];
}

export interface DiceTermView {
  label: string;
  rolls?: number[];
  value: number;
}

export type GameEvent = EventMeta &
  (
    | { kind: "chat"; from: PlayerRef; text: string }
    | { kind: "system"; text: string }
    | { kind: "action"; round: number; from: PlayerRef; text: string; private?: boolean }
    | { kind: "gm"; round: number; text: string }
    | {
        kind: "dice";
        round: number;
        reason: string;
        notation: string;
        terms: DiceTermView[];
        total: number;
        /** 私密擲骰的對象 */
        to?: PlayerRef;
      }
    | { kind: "private"; round: number; to: PlayerRef; text: string }
    | { kind: "host_note"; text: string }
  );

export interface MyAction {
  text: string;
  private: boolean;
}

// ---- server → client ----

export interface PlayerPresence extends PlayerRef {
  role: Role;
  online: boolean;
}

export interface RoundStatus {
  /** 正在收集行動的回合 */
  round: number;
  /** 已送出行動的玩家 ID */
  submitted: string[];
  /** GM 正在回應的回合；沒有則為 null */
  gmRound: number | null;
  paused: boolean;
}

/** 只送給主持人的控場資訊 */
export interface HostStatus {
  /** 等著併入下一回合的主持人指示 */
  notes: string[];
  /** SDK 估算的 session 累計花費（美元） */
  totalCostUsd: number;
  sessionId: string | null;
  model: string;
  effort: string;
  mock: boolean;
}

export type ServerMessage =
  | {
      type: "snapshot";
      you: PlayerRef & { role: Role };
      players: PlayerPresence[];
      events: GameEvent[];
      round: RoundStatus;
      /** 你本回合已送出的行動 */
      yourAction: MyAction | null;
      /** GM 回應到一半時重連，補上目前為止的文字 */
      gmPartial: string | null;
    }
  | { type: "presence"; players: PlayerPresence[] }
  | { type: "event"; event: GameEvent }
  | { type: "round_status"; round: RoundStatus }
  | { type: "your_action"; action: MyAction | null }
  | { type: "gm_delta"; round: number; text: string }
  | { type: "host_status"; status: HostStatus }
  | { type: "error"; code: string; message: string };
