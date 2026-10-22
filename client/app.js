"use strict";

const TOKEN_KEY = "trpg-token";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const logEl = $("log");
const playersEl = $("players");
const inputEl = $("input");

let me = null;
let ws = null;
let retryDelay = 1000;

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
        logEl.replaceChildren(...msg.events.map(renderEvent));
        renderPlayers(msg.players);
        scrollToBottom();
        break;
      case "presence":
        renderPlayers(msg.players);
        break;
      case "event": {
        const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
        logEl.append(renderEvent(msg.event));
        if (nearBottom || msg.event.from?.id === me?.id) scrollToBottom();
        break;
      }
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

function renderEvent(event) {
  const li = document.createElement("li");
  li.className = `event event-${event.kind}`;
  const time = document.createElement("time");
  time.dateTime = event.ts;
  time.textContent = new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (event.kind === "chat") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = event.from.name;
    if (event.from.id === me?.id) li.classList.add("mine");
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = event.text;
    li.append(who, time, text);
  } else {
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = event.text;
    li.append(text, time);
  }
  return li;
}

function appendLocalNotice(message) {
  logEl.append(renderEvent({ kind: "system", ts: new Date().toISOString(), text: message }));
  scrollToBottom();
}

function renderPlayers(players) {
  const sorted = [...players].sort((a, b) => Number(b.online) - Number(a.online));
  playersEl.replaceChildren(
    ...sorted.map((p) => {
      const li = document.createElement("li");
      li.className = p.online ? "online" : "offline";
      li.textContent = p.name + (p.role === "host" ? "（主持人）" : "");
      return li;
    }),
  );
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "chat", text }));
  inputEl.value = "";
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

const token = readToken();
if (token) {
  connect(token);
} else {
  setStatus("offline", "未登入");
  $("no-token").hidden = false;
}
