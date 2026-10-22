import { z } from "zod";
import { config } from "./config.js";
import type { Role } from "./store.js";

// ---- client → server ----

const text = z.string().trim().min(1).max(config.maxChatLength);

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().min(1).max(200) }),
  /** OOC 閒聊，不送 GM */
  z.object({ type: z.literal("chat"), text }),
  /** 本回合的角色行動；再送一次會覆蓋 */
  z.object({ type: z.literal("action"), text }),
  z.object({ type: z.literal("withdraw") }),
  /** host 限定：不等其他人，立即結算 */
  z.object({ type: z.literal("resolve_round") }),
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
}

export type GameEvent = EventMeta &
  (
    | { kind: "chat"; from: PlayerRef; text: string }
    | { kind: "system"; text: string }
    | { kind: "action"; round: number; from: PlayerRef; text: string }
    | { kind: "gm"; round: number; text: string }
  );

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
}

export type ServerMessage =
  | {
      type: "snapshot";
      you: PlayerRef & { role: Role };
      players: PlayerPresence[];
      events: GameEvent[];
      round: RoundStatus;
      /** 你本回合已送出的行動 */
      yourAction: string | null;
      /** GM 回應到一半時重連，補上目前為止的文字 */
      gmPartial: string | null;
    }
  | { type: "presence"; players: PlayerPresence[] }
  | { type: "event"; event: GameEvent }
  | { type: "round_status"; round: RoundStatus }
  | { type: "your_action"; text: string | null }
  | { type: "gm_delta"; round: number; text: string }
  | { type: "error"; code: string; message: string };
