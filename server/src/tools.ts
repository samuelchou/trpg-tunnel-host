import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { describeRoll, rollDice, type DiceRoll } from "./dice.js";

/** 工具執行時要通知伺服器的事情，由 Room 實作 */
export interface ToolSink {
  /** 擲骰結果；player 為 null 代表公開，否則只有該玩家（與主持人）看得到 */
  onDice(roll: DiceRoll, reason: string, player: string | null): void;
  /** 回傳 false 代表找不到這位玩家 */
  onPrivate(player: string, text: string): boolean;
  playerNames(): string[];
}

export const TOOL_SERVER_NAME = "trpg";
export const TOOL_NAMES = [`mcp__${TOOL_SERVER_NAME}__roll_dice`, `mcp__${TOOL_SERVER_NAME}__send_private`];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export const rollDiceInput = {
  notation: z.string().describe("骰子表示法，例如 1d20+3、2d6、1d100"),
  reason: z.string().describe("這次擲骰的目的，玩家會看到，例如「阿明的察覺檢定」"),
  private_to: z
    .string()
    .optional()
    .describe("只讓這位玩家看到結果時填玩家名字（例如私密行動的檢定）；公開擲骰不要填"),
};

export const sendPrivateInput = {
  player: z.string().describe("玩家名字（不是角色名）"),
  text: z.string().describe("只有這位玩家看得到的內容"),
};

export function runRollDice(
  args: { notation: string; reason: string; private_to?: string },
  sink: ToolSink,
): ToolResult {
  const target = args.private_to?.trim() || null;
  if (target && !sink.playerNames().includes(target)) {
    return fail(`沒有叫「${target}」的玩家。目前的玩家：${sink.playerNames().join("、")}`);
  }
  try {
    const roll = rollDice(args.notation);
    sink.onDice(roll, args.reason, target);
    return ok(`${args.reason}：${describeRoll(roll)}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function runSendPrivate(args: { player: string; text: string }, sink: ToolSink): ToolResult {
  const text = args.text.trim();
  if (!text) return fail("內容是空的");
  if (!sink.onPrivate(args.player.trim(), text)) {
    return fail(`沒有叫「${args.player}」的玩家。目前的玩家：${sink.playerNames().join("、")}`);
  }
  return ok(`已私下傳給 ${args.player}`);
}

/** 每回合建立一次，讓工具的 handler 綁定到這回合的 sink */
export function createToolServer(sink: ToolSink) {
  return createSdkMcpServer({
    name: TOOL_SERVER_NAME,
    tools: [
      tool(
        "roll_dice",
        "由伺服器公正地擲骰，結果會即時顯示給玩家。所有需要隨機性的判定都要用這個工具，不要自己編數字。",
        rollDiceInput,
        async (args) => runRollDice(args, sink),
        { alwaysLoad: true },
      ),
      tool(
        "send_private",
        "私下傳訊息給一位玩家，其他玩家看不到。用來回應私密行動、給個人線索或只有該角色察覺到的事。",
        sendPrivateInput,
        async (args) => runSendPrivate(args, sink),
        { alwaysLoad: true },
      ),
    ],
  });
}
