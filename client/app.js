"use strict";

const TOKEN_KEY = "trpg-token";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const logEl = $("log");
const playersEl = $("players");
const inputEl = $("input");

const PLACEHOLDER = {
  action: "描述你的角色這回合要做什麼（Enter 送出，Shift+Enter 換行）",
  private: "只有 GM 看得到的行動，例如偷偷做某件事（Enter 送出，Shift+Enter 換行）",
  chat: "跟大家閒聊，GM 看不到（Enter 送出，Shift+Enter 換行）",
};

let me = null;
let ws = null;
let retryDelay = 1000;
let players = [];
let round = { round: 1, submitted: [], gmRound: null };
/** GM 正在串流的敘事區塊 */
let streaming = null;

// 邀請連結帶的 token 在 hash 裡（#t=...），讀出後存起來並從網址列移除
function readToken() {
  const match = location.hash.match(/[#&]t=([^&]+)/);
  if (match) {
    const token = decodeURIComponent(match[1]);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function connect(token) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  setStatus("connecting", "連線中…");

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", token }));
  });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "snapshot":
        retryDelay = 1000;
        me = msg.you;
        setStatus("online", `已連線：${me.name}${me.role === "host" ? "（主持人）" : ""}`);
        $("table").hidden = false;
        $("resolve").hidden = me.role !== "host";
        streaming = null;
        logEl.replaceChildren(...msg.events.map(renderEvent));
        if (msg.gmPartial !== null) appendGmDelta(msg.round.gmRound, msg.gmPartial);
        players = msg.players;
        round = msg.round;
        renderPlayers();
        renderRound();
        renderMyAction(msg.yourAction);
        scrollToBottom();
        break;
      case "presence":
        players = msg.players;
        renderPlayers();
        renderRound();
        break;
      case "round_status":
        round = msg.round;
        if (round.gmRound === null && streaming) {
          // GM 沒有送出正式敘事就結束了（失敗或中斷）
          streaming.el.classList.replace("streaming", "interrupted");
          streaming = null;
        }
        renderPlayers();
        renderRound();
        break;
      case "your_action":
        renderMyAction(msg.action);
        break;
      case "gm_delta":
        withAutoScroll(() => appendGmDelta(msg.round, msg.text));
        break;
      case "event":
        withAutoScroll(() => {
          if (msg.event.kind === "gm" && streaming?.round === msg.event.round) {
            // 串流結束，換成正式事件
            streaming.el.replaceWith(renderEvent(msg.event));
            streaming = null;
          } else if (streaming) {
            // GM 敘事進行中產生的擲骰、私訊，放在敘事前面
            logEl.insertBefore(renderEvent(msg.event), streaming.el);
          } else {
            logEl.append(renderEvent(msg.event));
          }
        }, msg.event.from?.id === me?.id);
        break;
      case "error":
        appendLocalNotice(msg.message);
        break;
    }
  });

  ws.addEventListener("close", (e) => {
    if (e.code === 4003) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {}
      setStatus("offline", "邀請連結無效");
      $("table").hidden = true;
      $("no-token").hidden = false;
      return;
    }
    setStatus("offline", `連線中斷，${Math.round(retryDelay / 1000)} 秒後重試…`);
    setTimeout(() => connect(token), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  });
}

function withAutoScroll(fn, force = false) {
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
  fn();
  if (nearBottom || force) scrollToBottom();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeEl(ts) {
  const time = el("time", "", new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  time.dateTime = ts;
  return time;
}

function renderEvent(event) {
  const li = el("li", `event event-${event.kind}`);
  switch (event.kind) {
    case "chat":
      if (event.from.id === me?.id) li.classList.add("mine");
      li.append(el("span", "who", event.from.name), timeEl(event.ts), el("p", "text", event.text));
      break;
    case "action":
      if (event.from.id === me?.id) li.classList.add("mine");
      if (event.private) li.classList.add("private");
      li.append(el("span", "tag", `回合 ${event.round}`));
      if (event.private) li.append(el("span", "tag tag-private", "私密"));
      li.append(el("span", "who", event.from.name), el("p", "text", event.text));
      break;
    case "dice": {
      if (event.to) li.classList.add("private");
      const detail = event.terms
        .map((t, i) => {
          const op = t.value < 0 || t.label.startsWith("-") ? "-" : i === 0 ? "" : "+";
          return op + (t.rolls ? `[${t.rolls.join(",")}]` : String(Math.abs(t.value)));
        })
        .join("");
      li.append(
        el("span", "dice-icon", "🎲"),
        el("span", "reason", event.reason),
        el("span", "detail", `${event.notation} → ${detail} =`),
        el("strong", "total", String(event.total)),
      );
      if (event.to) li.append(el("span", "tag tag-private", event.to.id === me?.id ? "只有你看得到" : `私密：${event.to.name}`));
      break;
    }
    case "private":
      li.append(
        el("span", "who", event.to.id === me?.id ? "GM 私下告訴你" : `GM 私下告訴 ${event.to.name}`),
        timeEl(event.ts),
        el("p", "text", event.text),
      );
      break;
    case "gm":
      li.append(el("span", "who", "GM"), timeEl(event.ts), el("p", "text", event.text));
      break;
    default:
      li.append(el("span", "text", event.text), timeEl(event.ts));
  }
  return li;
}

function appendGmDelta(roundNo, text) {
  if (!streaming || streaming.round !== roundNo) {
    const li = el("li", "event event-gm streaming");
    const body = el("p", "text", "");
    li.append(el("span", "who", "GM"), body);
    logEl.append(li);
    streaming = { round: roundNo, el: li, body };
  }
  streaming.body.textContent += text;
}

function appendLocalNotice(message) {
  withAutoScroll(() => logEl.append(renderEvent({ kind: "system", ts: new Date().toISOString(), text: message })), true);
}

function renderPlayers() {
  const sorted = [...players].sort((a, b) => Number(b.online) - Number(a.online));
  playersEl.replaceChildren(
    ...sorted.map((p) => {
      const li = el("li", p.online ? "online" : "offline", p.name + (p.role === "host" ? "（主持人）" : ""));
      if (round.submitted.includes(p.id)) li.append(el("span", "done", "已行動"));
      return li;
    }),
  );
}

function renderRound() {
  const text = $("round-text");
  if (round.gmRound !== null) {
    text.textContent = `GM 正在描述回合 ${round.gmRound}…`;
  } else {
    const required = players.filter((p) => p.role === "player" && p.online);
    const done = required.filter((p) => round.submitted.includes(p.id)).length;
    text.textContent = `回合 ${round.round}：已行動 ${done}/${required.length}`;
  }
  $("resolve").disabled = round.gmRound !== null || round.submitted.length === 0;
}

function renderMyAction(action) {
  $("my-action").hidden = action === null;
  $("my-action").classList.toggle("private", !!action?.private);
  $("my-action-label").textContent = action?.private ? "你本回合的私密行動（只有 GM 看得到）" : "你本回合的行動";
  $("my-action-text").textContent = action?.text ?? "";
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const mode = currentMode();
  send(mode === "chat" ? { type: "chat", text } : { type: "action", text, private: mode === "private" });
  inputEl.value = "";
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    inputEl.placeholder = PLACEHOLDER[currentMode()];
    inputEl.focus();
  });
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("withdraw").addEventListener("click", () => send({ type: "withdraw" }));
$("resolve").addEventListener("click", () => send({ type: "resolve_round" }));

// 在已開啟的分頁貼上另一條邀請連結時，只有 hash 會變，頁面不會重新載入
window.addEventListener("hashchange", () => {
  if (/[#&]t=/.test(location.hash)) {
    readToken();
    location.reload();
  }
});

const token = readToken();
if (token) {
  connect(token);
} else {
  setStatus("offline", "未登入");
  $("no-token").hidden = false;
}
