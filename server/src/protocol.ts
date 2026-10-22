import { z } from "zod";
import { config } from "./config.js";
import type { Role } from "./store.js";

// ---- client → server ----

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string().min(1).max(200) }),
  z.object({
    type: z.literal("chat"),
    text: z.string().trim().min(1).max(config.maxChatLength),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- 事件（寫入 log.jsonl，重連時重播） ----

export interface PlayerRef {
  id: string;
  name: string;
}

export type GameEvent =
  | { id: string; ts: string; kind: "chat"; from: PlayerRef; text: string }
  | { id: string; ts: string; kind: "system"; text: string };

// ---- server → client ----

export interface PlayerPresence extends PlayerRef {
  role: Role;
  online: boolean;
}

export type ServerMessage =
  | {
      type: "snapshot";
      you: PlayerRef & { role: Role };
      players: PlayerPresence[];
      events: GameEvent[];
    }
  | { type: "presence"; players: PlayerPresence[] }
  | { type: "event"; event: GameEvent }
  | { type: "error"; code: string; message: string };
