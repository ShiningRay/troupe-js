/** BoxOffice 演示页：浏览器经 WebSocket 直调 Actor（ticket 鉴权时 URL 带 ?ticket=） */
export const BOXOFFICE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Troupe BoxOffice</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, Menlo, monospace; background: #0d1117; color: #e6edf3; padding: 20px; }
  h1 { font-size: 18px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin-bottom: 14px; max-width: 720px; }
  input, button { font: inherit; border-radius: 6px; padding: 6px 10px; }
  input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; width: 180px; }
  button { background: #238636; border: 1px solid #2ea043; color: #fff; cursor: pointer; }
  #status.ok { color: #3fb950; } #status.err { color: #f85149; }
  #log { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; min-height: 200px; max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
</style>
</head>
<body>
<h1>🎟️ Troupe BoxOffice</h1>
<div class="card">
  <div class="row">
    <span>状态：<span id="status" class="muted">未连接</span></span>
  </div>
  <div class="row">
    <input id="roleId" value="Cart" placeholder="roleId">
    <input id="stageName" value="user-1" placeholder="stageName">
    <input id="method" value="add" placeholder="method">
    <input id="args" value='["apple"]' placeholder='args JSON 数组' style="width:240px">
    <button id="send">调用</button>
  </div>
  <div class="row muted">
    浏览器 → WebSocket → BoxOffice → troupe.cast（白名单/串行 Turn/持久化）
  </div>
  <div id="log"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const proto = location.protocol === "https:" ? "wss" : "ws";
let ws;
function connect() {
  ws = new WebSocket(proto + "://" + location.host + "/ws" + (qs.get("ticket") ? "?ticket=" + encodeURIComponent(qs.get("ticket")) : ""));
  ws.onopen = () => { $("status").textContent = "● 已连接"; $("status").className = "ok"; };
  ws.onclose = () => { $("status").textContent = "● 断开"; $("status").className = "err"; };
  ws.onmessage = (ev) => log("← " + ev.data);
}
function log(t) { const d = document.createElement("div"); d.textContent = t; $("log").appendChild(d); $("log").scrollTop = 1e9; }
$("send").onclick = () => {
  let args;
  try { args = JSON.parse($("args").value || "[]"); } catch { log("✗ args 不是合法 JSON"); return; }
  const msg = { op: "call", callId: crypto.randomUUID(), roleId: $("roleId").value.trim(), stageName: $("stageName").value.trim(), method: $("method").value.trim(), args };
  log("→ " + JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
};
connect();
</script>
</body>
</html>
`;
