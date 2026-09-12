/** 聊天室前端：单文件、零构建；SSE 实时收消息，发送带幂等重试（结果未知 → 同 msgId 重试，§6.5） */
export const CHAT_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Troupe 聊天室</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "PingFang SC", sans-serif; background: #0d1117; color: #e6edf3; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 10px 18px; border-bottom: 1px solid #30363d; }
  header h1 { font-size: 16px; margin: 0; }
  .muted { color: #9aa4b2; font-size: 12px; }
  #conn.ok { color: #3fb950; } #conn.err { color: #f85149; }
  #layout { flex: 1; display: flex; min-height: 0; }
  #msgs { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 6px; }
  .msg { max-width: 72%; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 6px 12px; }
  .msg.mine { align-self: flex-end; background: #1b3a5b; border-color: #265985; }
  .msg .who { color: #58a6ff; font-size: 12px; margin-right: 8px; }
  .msg .at { color: #6e7681; font-size: 11px; margin-left: 8px; }
  .msg .txt { white-space: pre-wrap; word-break: break-word; }
  .msg.pending { opacity: .55; }
  #side { width: 170px; border-left: 1px solid #30363d; padding: 12px; overflow-y: auto; }
  #side h2 { font-size: 12px; color: #9aa4b2; margin: 0 0 8px; font-weight: 500; }
  #side li { list-style: none; padding: 3px 0; }
  footer { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid #30363d; }
  #text { flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font: inherit; padding: 8px 12px; }
  #text:focus { outline: none; border-color: #388bfd; }
  button { background: #238636; border: 1px solid #2ea043; color: #fff; border-radius: 8px; font: inherit; padding: 8px 18px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #overlay { position: fixed; inset: 0; background: rgba(13,17,23,.92); display: flex; align-items: center; justify-content: center; }
  #overlay.hidden { display: none; }
  #join-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 26px 30px; width: 320px; text-align: center; }
  #join-card h1 { font-size: 20px; margin: 0 0 4px; }
  #nick { width: 100%; margin: 14px 0; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font: inherit; padding: 8px 12px; text-align: center; }
  #notice { min-height: 18px; font-size: 12px; color: #d29922; padding: 0 18px; }
</style>
</head>
<body>
<header>
  <h1>💬 Troupe 聊天室</h1>
  <span id="room" class="muted"></span>
  <span id="conn" class="muted">连接中…</span>
  <span class="muted" style="margin-left:auto">Room Actor · SQLite 持久化 · 幂等发送</span>
</header>
<div id="layout">
  <div id="msgs"></div>
  <aside id="side"><h2>成员</h2><ul id="members"></ul></aside>
</div>
<div id="notice"></div>
<footer>
  <input id="text" placeholder="输入消息，回车发送…" maxlength="500" autocomplete="off">
  <button id="send">发送</button>
</footer>
<div id="overlay">
  <div id="join-card">
    <h1>💬 加入聊天室</h1>
    <div class="muted">昵称进入；消息由 Room Actor 串行处理并持久化</div>
    <input id="nick" placeholder="你的昵称" maxlength="32">
    <button id="join">进入</button>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const ROOM = qs.get("room") || "lobby";
$("room").textContent = "#" + ROOM;

let me = null;
let cursor = 0;

function addMsg(m, pending) {
  if (m.id <= cursor && !pending) { return; }
  if (!pending) cursor = Math.max(cursor, m.id);
  const div = document.createElement("div");
  div.className = "msg" + (m.user === me ? " mine" : "") + (pending ? " pending" : "");
  const who = document.createElement("span"); who.className = "who"; who.textContent = m.user;
  const at = document.createElement("span"); at.className = "at";
  at.textContent = new Date(m.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const txt = document.createElement("div"); txt.className = "txt"; txt.textContent = m.text;
  if (pending) div.dataset.msgId = m.msgId;
  div.append(who, at, txt);
  $("msgs").appendChild(div);
  $("msgs").scrollTop = $("msgs").scrollHeight;
  return div;
}

function setMembers(list) {
  const ul = $("members"); ul.innerHTML = "";
  for (const m of list) {
    const li = document.createElement("li");
    li.textContent = (m === me ? "● " : "○ ") + m;
    ul.appendChild(li);
  }
}

function notice(t) { $("notice").textContent = t || ""; }

let es = null;
function connect() {
  es = new EventSource("/api/stream?room=" + ROOM + "&user=" + encodeURIComponent(me));
  es.onopen = () => { $("conn").textContent = "● 已连接"; $("conn").className = "ok"; };
  es.onerror = () => { $("conn").textContent = "● 重连中…"; $("conn").className = "err"; };
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "init") { cursor = 0; $("msgs").innerHTML = ""; d.messages.forEach(m => addMsg(m)); setMembers(d.members); }
    else if (d.type === "message") { addMsg(d.message); }
    else if (d.type === "members") { setMembers(d.members); }
  };
}

// 幂等发送：失败（结果未知）用同一 msgId 重试——服务端去重，不重不漏（§6.5）
async function doSend(text) {
  const msgId = crypto.randomUUID();
  const pendingEl = addMsg({ user: me, text, at: Date.now(), msgId }, true);
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch("/api/send?room=" + ROOM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgId, user: me, text }),
      });
      const data = await res.json();
      if (res.ok && data.ok) { pendingEl.remove(); notice(""); return; }
      if (res.status === 409) { pendingEl.remove(); notice("发送失败：" + data.error); return; }
      throw new Error(data.error || res.status);
    } catch (e) {
      if (attempt >= 5) { pendingEl.remove(); notice("发送失败（已重试 " + attempt + " 次）：" + e); return; }
      notice("结果未知，同 msgId 幂等重试中…（第 " + attempt + " 次）");
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
}

$("join").onclick = async () => {
  const nick = $("nick").value.trim();
  if (!nick) return;
  me = nick;
  await fetch("/api/join?room=" + ROOM, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: me }),
  });
  $("overlay").classList.add("hidden");
  connect();
  $("text").focus();
};
$("nick").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join").click(); });
$("send").onclick = () => { const t = $("text").value.trim(); if (t) { $("text").value = ""; doSend(t); } };
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter") $("send").click(); });
</script>
</body>
</html>
`;
