/** Booth 预览版页面：零构建、无外部资源，轮询 /api/overview 渲染 */
export const BOOTH_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Troupe Booth</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: #0d1117; color: #e6edf3; }
  header { padding: 14px 20px; border-bottom: 1px solid #30363d; display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 14px; margin: 0 0 8px; color: #9aa4b2; }
  .muted { color: #9aa4b2; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { background: #161b22; border: 1px solid #30363d; border-radius: 999px; padding: 1px 10px; font-size: 12px; }
  .chip.self { border-color: #2ea043; color: #3fb950; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 20px; max-width: 1200px; margin: 0 auto; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; min-width: 0; }
  section.full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { color: #9aa4b2; font-weight: 500; }
  td.num, th.num { text-align: right; }
  .st { padding: 0 8px; border-radius: 999px; font-size: 12px; }
  .st-running { background: #0f2e17; color: #3fb950; }
  .st-activating { background: #3a2c00; color: #d29922; }
  .st-draining { background: #3d2200; color: #db6d28; }
  .st-invalid { background: #3d1116; color: #f85149; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 3px 10px; font: inherit; cursor: pointer; }
  button:hover { background: #30363d; }
  button.warn { border-color: #b3423b; color: #f85149; }
  #events { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; font-size: 12px; }
  #events li { padding: 2px 6px; border-bottom: 1px solid #21262d; display: flex; gap: 8px; }
  #events .t { color: #9aa4b2; min-width: 8em; }
  .e-warn { color: #d29922; } .e-invalidated, .e-saveFailed, .e-offStageFailed, .e-activationFailed { color: #f85149; }
  .e-turnStarted { color: #58a6ff; } .e-turnEnded { color: #9aa4b2; }
  form { display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 8px; align-items: start; }
  input, textarea { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font: inherit; padding: 4px 8px; width: 100%; }
  textarea { grid-column: 1 / 4; min-height: 54px; }
  #result { grid-column: 1 / -1; white-space: pre-wrap; word-break: break-all; color: #9aa4b2; margin: 4px 0 0; min-height: 1.2em; }
  .ok { color: #3fb950 !important; } .err { color: #f85149 !important; }
</style>
</head>
<body>
<header>
  <h1>🎭 Troupe Booth <span class="muted" style="font-size:12px">预览版</span></h1>
  <span id="conn" class="muted">连接中…</span>
  <span id="stage-info" class="muted"></span>
  <div id="members" class="chips"></div>
</header>
<main>
  <section>
    <h2>在场 Actor（状态机 · DESING §5.2）</h2>
    <table>
      <thead><tr><th>角色</th><th>stageName</th><th>状态</th><th class="num">排队</th><th class="num">rev</th><th class="num">空闲</th><th></th></tr></thead>
      <tbody id="actors"></tbody>
    </table>
    <div class="muted" id="actors-empty">（暂无在场 Actor）</div>
  </section>
  <section>
    <h2>指标（每角色）</h2>
    <table>
      <thead><tr><th>角色</th><th class="num">调用</th><th class="num">错误</th><th class="num">拒绝</th><th class="num">p50</th><th class="num">p99</th><th class="num">max</th></tr></thead>
      <tbody id="metrics"></tbody>
    </table>
    <div class="muted" id="metrics-empty">（暂无调用）</div>
  </section>
  <section class="full">
    <h2>调用面板（白名单校验 · §6.1）</h2>
    <form id="call-form">
      <input id="c-role" placeholder="roleId（如 Cart）" list="role-list" required>
      <datalist id="role-list"></datalist>
      <input id="c-stage" placeholder="stageName" required>
      <input id="c-method" placeholder="method" required>
      <button type="submit">调用</button>
      <textarea id="c-args" placeholder='args 的 JSON 数组，如 ["apple", 1]'>[]</textarea>
      <button type="button" id="c-off" class="warn">强制下场</button>
      <pre id="result"></pre>
    </form>
  </section>
  <section class="full">
    <h2>事件流（最近 200 条）</h2>
    <ul id="events"></ul>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s);
const fmtMs = (ms) => ms < 0 ? "—" : ms >= 60000 ? Math.round(ms/60000) + "m" : ms >= 1000 ? (ms/1000).toFixed(1) + "s" : Math.round(ms) + "ms";

function render(d) {
  const st = d.stage;
  $("stage-info").textContent =
    st.addr + " · pid " + st.pid + " · 启动 " + fmtMs(st.uptimeMs) + " · node " + st.node + " · ns " + st.namespace;
  $("members").innerHTML = "";
  for (const m of d.members) {
    const el = document.createElement("span");
    el.className = "chip" + (m === st.addr ? " self" : "");
    el.textContent = (m === st.addr ? "★ " : "") + m;
    $("members").appendChild(el);
  }
  const tb = $("actors"); tb.innerHTML = "";
  $("actors-empty").style.display = d.actors.length ? "none" : "block";
  for (const a of d.actors) {
    const tr = document.createElement("tr");
    const cells = [a.roleId, a.stageName,
      '<span class="st st-' + a.state + '">' + a.state + "</span>",
      a.queued, a.revision || "—", fmtMs(a.idleMs), ""];
    cells.forEach((c, i) => {
      const td = document.createElement(i >= 3 && i <= 5 ? "td" : "td");
      if (i >= 3 && i <= 5) td.className = "num";
      if (i === 2) td.innerHTML = c; else td.textContent = c;
      tr.appendChild(td);
    });
    const td = tr.lastChild;
    const btn = document.createElement("button");
    btn.textContent = "下场";
    btn.onclick = () => act("/api/off", { roleId: a.roleId, stageName: a.stageName });
    td.appendChild(btn);
    const fill = document.createElement("button");
    fill.textContent = "调";
    fill.onclick = () => { $("c-role").value = a.roleId; $("c-stage").value = a.stageName; };
    td.appendChild(fill);
    tb.appendChild(tr);
  }
  const roles = Object.keys(d.metrics);
  const mb = $("metrics"); mb.innerHTML = "";
  $("metrics-empty").style.display = roles.length ? "none" : "block";
  for (const r of roles) {
    const m = d.metrics[r];
    const tr = document.createElement("tr");
    [r, m.calls, m.errors, m.rejections,
     Math.round(m.latency.p50) + "ms", Math.round(m.latency.p99) + "ms", Math.round(m.latency.max) + "ms"]
      .forEach((c, i) => { const td = document.createElement("td"); if (i > 0) td.className = "num"; td.textContent = c; tr.appendChild(td); });
    mb.appendChild(tr);
  }
  $("role-list").innerHTML = roles.concat(d.actors.map(a => a.roleId)).filter((v, i, arr) => arr.indexOf(v) === i)
    .map(r => '<option value="' + esc(r) + '">').join("");
  const ul = $("events"); ul.innerHTML = "";
  for (const e of d.events.slice(0, 200)) {
    const li = document.createElement("li");
    li.className = "e-" + e.type;
    const t = document.createElement("span"); t.className = "t"; t.textContent = new Date(e.at).toLocaleTimeString();
    const b = document.createElement("span");
    b.textContent = e.type + "  " + (e.roleId || "") + (e.stageName ? "/" + e.stageName : "") + (e.method ? "." + e.method : "");
    li.append(t, b); ul.appendChild(li);
  }
}

async function act(path, body) {
  const out = $("result");
  out.className = "";
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) { out.className = "err"; out.textContent = "✗ " + (data.error || res.status); }
    else { out.className = "ok"; out.textContent = "✓ " + JSON.stringify(data.result ?? data, null, 2); }
  } catch (e) { out.className = "err"; out.textContent = "✗ " + e; }
  // 界面更新由 SSE 推送负责（服务端事件 → ~250ms 合并推送）
}

$("call-form").onsubmit = (ev) => {
  ev.preventDefault();
  let args;
  try { args = JSON.parse($("c-args").value || "[]"); } catch (e) { const o = $("result"); o.className = "err"; o.textContent = "✗ args 不是合法 JSON 数组"; return; }
  if (!Array.isArray(args)) { const o = $("result"); o.className = "err"; o.textContent = "✗ args 必须是数组"; return; }
  act("/api/call", { roleId: $("c-role").value.trim(), stageName: $("c-stage").value.trim(), method: $("c-method").value.trim(), args });
};
$("c-off").onclick = () => act("/api/off", { roleId: $("c-role").value.trim(), stageName: $("c-stage").value.trim() });

// SSE 实时推送（DESIGN §11.3）：连接即收快照，事件驱动 ~250ms 合并推送 + 1s 保活帧
const es = new EventSource("/api/stream");
es.onopen = () => { $("conn").textContent = "● SSE 已连接"; $("conn").className = "ok"; };
es.onerror = () => { $("conn").textContent = "● 连接断开，自动重连中…"; $("conn").className = "err"; };
es.onmessage = (ev) => {
  try { render(JSON.parse(ev.data)); } catch { /* 忽略坏帧 */ }
};
</script>
</body>
</html>
`;
