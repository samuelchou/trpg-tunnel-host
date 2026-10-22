import path from "node:path";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { createToolServer, runRollDice, runSendPrivate, TOOL_NAMES, TOOL_SERVER_NAME, type ToolSink } from "./tools.js";

export interface GmCallbacks {
  /** GM 敘事的文字增量 */
  onText(delta: string): void;
  /** 拿到 session ID 時呼叫（新 session 會在第一則訊息就拿到，可以先存起來） */
  onSessionId(sessionId: string): void;
  /** roll_dice / send_private 工具的結果要送到哪裡 */
  tools: ToolSink;
}

export interface GmResult {
  text: string;
  sessionId?: string;
  /** SDK 估算的 session 累計花費（美元） */
  sessionCostUsd?: number;
}

export interface Gm {
  run(
    prompt: string,
    sessionId: string | undefined,
    callbacks: GmCallbacks,
    abort: AbortController,
  ): Promise<GmResult>;
}

const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const WRITABLE_DIRS = ["characters", "story"].map((d) => path.join(config.gmDir, d) + path.sep);
const SAVES_DIR = path.join(config.gmDir, "saves") + path.sep;

const GM_DIR = config.gmDir + path.sep;

/** dir 必須以 path.sep 結尾；file 等於 dir 本身也算在裡面 */
function inside(file: string, dir: string) {
  return (file + path.sep).startsWith(dir);
}

/**
 * 第二層防護（第一層是 tools 白名單與 gm/.claude/settings.json 的權限規則）：
 * 只准讀 gm/ 底下（saves/ 除外），只准寫 characters/ 與 story/；
 * 除了伺服器提供的 TRPG 工具，其他工具一律拒絕。
 */
export const guardTools: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

  if (TOOL_NAMES.includes(input.tool_name)) return {};
  if (!FILE_TOOLS.includes(input.tool_name)) return deny(`GM 不能使用 ${input.tool_name}`);

  const toolInput = (input.tool_input ?? {}) as { file_path?: string; path?: string };
  const target = path.resolve(config.gmDir, toolInput.file_path ?? toolInput.path ?? ".");
  if (!inside(target, GM_DIR)) {
    return deny("只能存取 GM 資料夾裡的檔案");
  }
  if (inside(target, SAVES_DIR)) return deny("saves/ 是伺服器的存檔，GM 不能讀取");
  // 寫入必須落在子資料夾「裡面」，不能是資料夾本身
  if (WRITE_TOOLS.has(input.tool_name) && !WRITABLE_DIRS.some((d) => target.startsWith(d))) {
    return deny("GM 只能修改 characters/ 與 story/ 底下的檔案");
  }
  return {};
};

const SYSTEM_APPEND = `
你正在透過多人 TRPG 伺服器擔任遊戲主持人。每則使用者訊息是一整個回合的玩家行動。
你輸出的所有文字都會即時廣播給全體玩家，所以：
- 只輸出給玩家看的敘事；需要讀寫檔案時，直接使用工具，前後不要輸出任何說明文字。
- 不要提到檔案、工具、伺服器或你是 AI。
- 需要隨機判定時一律用 roll_dice 工具，擲骰結果玩家會直接看到，敘事裡不必重複數字細節。
- 標示為【私密】的行動只有你和該玩家知道：它的結果用 send_private 私下告訴那位玩家，公開敘事裡不能透露。
`.trim();

export class AgentGm implements Gm {
  async run(
    prompt: string,
    sessionId: string | undefined,
    callbacks: GmCallbacks,
    abort: AbortController,
  ): Promise<GmResult> {
    let text = "";
    let currentSession = sessionId;
    let sessionCostUsd: number | undefined;
    let failure: string | undefined;

    const emit = (delta: string) => {
      text += delta;
      callbacks.onText(delta);
    };

    const stream = query({
      prompt,
      options: {
        cwd: config.gmDir,
        resume: sessionId,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
        tools: FILE_TOOLS,
        disallowedTools: ["Bash", "WebFetch", "WebSearch"],
        allowedTools: ["Edit(characters/**)", "Edit(story/**)", ...TOOL_NAMES],
        mcpServers: { [TOOL_SERVER_NAME]: createToolServer(callbacks.tools) },
        permissionMode: "dontAsk",
        hooks: { PreToolUse: [{ hooks: [guardTools] }] },
        model: config.gm.model,
        effort: config.gm.effort,
        maxBudgetUsd: config.gm.maxBudgetPerRoundUsd,
        maxTurns: config.gm.maxTurns,
        includePartialMessages: true,
        abortController: abort,
      },
    });

    try {
      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          if (message.apiKeySource === "none") {
            console.warn("[gm] 沒有使用 ANTHROPIC_API_KEY，正在使用 claude 登入的帳號額度");
          }
          if (message.session_id !== currentSession) {
            currentSession = message.session_id;
            callbacks.onSessionId(message.session_id);
          }
        } else if (message.type === "stream_event" && message.parent_tool_use_id === null) {
          const event = message.event;
          if (event.type === "content_block_start" && event.content_block.type === "text" && text) {
            // 工具呼叫前後是不同的文字區塊，中間補空行
            emit("\n\n");
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            emit(event.delta.text);
          }
        } else if (message.type === "result") {
          sessionCostUsd = message.total_cost_usd;
          // 像「沒有登入」這類錯誤，subtype 仍是 success，只有 is_error 為 true
          if (message.subtype === "success" && !message.is_error) {
            if (!text.trim()) text = message.result;
          } else {
            failure = message.subtype === "success" ? message.result : message.subtype;
          }
        }
      }
    } catch (err) {
      // 錯誤結果之後 query() 會再丟出例外；已經有 failure 就以它為準
      if (!failure) failure = err instanceof Error ? err.message : String(err);
    }

    if (failure) {
      throw new GmError(failure, { text, sessionId: currentSession, sessionCostUsd });
    }
    return { text: text.trim(), sessionId: currentSession, sessionCostUsd };
  }
}

export class GmError extends Error {
  constructor(
    message: string,
    readonly partial: GmResult,
  ) {
    super(message);
  }
}

/**
 * 不呼叫 Claude 的假 GM，用來開發 UI 和測試回合流程：
 * 公開行動逐字吐回來並擲一顆 d20，私密行動用 send_private 私下回覆。
 */
export class MockGm implements Gm {
  async run(
    prompt: string,
    sessionId: string | undefined,
    callbacks: GmCallbacks,
    abort: AbortController,
  ): Promise<GmResult> {
    const id = sessionId ?? "mock-session";
    if (!sessionId) callbacks.onSessionId(id);

    const publicLines: string[] = [];
    for (const line of prompt.split("\n")) {
      const secret = line.match(/^- 【私密】(.+?)：(.*)$/);
      if (secret) {
        runSendPrivate({ player: secret[1], text: `（模擬 GM）你的私密行動「${secret[2]}」沒有被任何人發現。` }, callbacks.tools);
      } else {
        publicLines.push(line);
      }
    }
    runRollDice({ notation: "1d20", reason: "模擬 GM 的測試擲骰" }, callbacks.tools);

    const reply = `（模擬 GM）我收到了這些行動：\n${publicLines.join("\n")}\n\n四周一片寂靜……你們接下來要做什麼？`;
    let text = "";
    for (const ch of reply) {
      if (abort.signal.aborted) throw new GmError("aborted", { text, sessionId: id });
      await new Promise((r) => setTimeout(r, 5));
      text += ch;
      callbacks.onText(ch);
    }
    return { text, sessionId: id, sessionCostUsd: 0 };
  }
}

export function createGm(): Gm {
  return config.gm.mock ? new MockGm() : new AgentGm();
}
