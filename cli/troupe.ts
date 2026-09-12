/**
 * troupe CLI（M4，DESIGN §11.2）：Director 的瘦客户端。
 *   npx tsx cli/troupe.ts <命令> [参数] [--to host:port] [--json] [--token <t>]
 * 命令：status | roster | ps [--role R] | inspect <role> <stageName> |
 *       call <role> <stageName> <method> [argsJSON] | off <role> <stageName> | cues | ring
 * 连接：--to 或 TROUPE_ADMIN 或默认 127.0.0.1:7300（DESIGN §11.2；手写解析保持零依赖）
 */
import { randomUUID } from "node:crypto";
import { Transport, type WireMessage, type WireResponse } from "../src/cluster/transport.js";

interface CliOptions {
  to: string;
  json: boolean;
  token?: string;
  role?: string;
}

function parseArgs(argv: string[]): { command: string; rest: string[]; opts: CliOptions } {
  const opts: CliOptions = {
    to: process.env.TROUPE_ADMIN ?? "127.0.0.1:7300",
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") opts.to = argv[++i] ?? opts.to;
    else if (a === "--json") opts.json = true;
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else positional.push(a);
  }
  return { command: positional[0] ?? "status", rest: positional.slice(1), opts };
}

async function directorRoundtrip(
  opts: CliOptions,
  method: string,
  args: unknown[],
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const client = new Transport((_m: WireMessage, _r) => {});
  try {
    const callId = randomUUID();
    const res = (await client.request(
      opts.to,
      { t: "dir", callId, from: "cli", method, args, ...(opts.token ? { token: opts.token } : {}) },
      callId,
      10_000,
    )) as WireResponse;
    if (res.ok) return { ok: true, result: res.result ?? null };
    const err = res.err!;
    return { ok: false, error: `${err.name}: ${err.message}` };
  } finally {
    client.destroy();
  }
}

function table(rows: Array<Record<string, unknown>>, columns: Array<[string, string]>): string {
  const widths = columns.map(([key]) =>
    Math.max(key.length, ...rows.map((r) => String(r[key] ?? "").length)),
  );
  const head = columns.map(([key], i) => key.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  const body = rows
    .map((r) => columns.map(([key], i) => String(r[key] ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
  return [head, sep, body].join("\n");
}

function fmtMs(ms: number): string {
  return ms < 0 ? "—" : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

async function main(): Promise<void> {
  const { command, rest, opts } = parseArgs(process.argv.slice(2));
  const out = await (async (): Promise<string> => {
    switch (command) {
      case "status": {
        const r = await directorRoundtrip(opts, "roster", []);
        if (!r.ok) return `✗ ${r.error}`;
        const d = r.result as { members: string[]; uptimeMs: number; pid: number; roles: string[] };
        const actors = (await directorRoundtrip(opts, "actors", [])) as
          | { ok: true; result: Array<{ roleId: string }> }
          | { ok: false; error: string };
        const n = actors.ok ? actors.result.length : "?";
        return opts.json
          ? JSON.stringify({ ...d, actorsOnStage: n }, null, 2)
          : `Stage      ${d.members[0]}（pid ${d.pid}，启动 ${fmtMs(d.uptimeMs)}）
成员       ${d.members.length}
在场 Actor ${n}
角色       ${d.roles.join(", ") || "（空）"}`;
      }
      case "roster": {
        const r = await directorRoundtrip(opts, "roster", []);
        if (!r.ok) return `✗ ${r.error}`;
        const d = r.result as { members: string[]; self: string };
        if (opts.json) return JSON.stringify(d, null, 2);
        return table(
          d.members.map((m) => ({ addr: m, 本Stage: m === d.self ? "★" : "" })),
          [["addr", "地址"], ["本Stage", "本Stage"]],
        );
      }
      case "ps": {
        const r = await directorRoundtrip(opts, "actors", [opts.role ? { role: opts.role } : undefined]);
        if (!r.ok) return `✗ ${r.error}`;
        const actors = r.result as Array<{
          roleId: string; stageName: string; state: string; queued: number; revision: number; idleMs: number | null;
        }>;
        if (opts.json) return JSON.stringify(actors, null, 2);
        if (actors.length === 0) return "（无在场 Actor）";
        return table(
          actors.map((a) => ({ ...a, rev: a.revision || "—", idle: a.idleMs === null ? "—" : fmtMs(a.idleMs) })),
          [["roleId", "角色"], ["stageName", "stageName"], ["state", "状态"], ["queued", "排队"], ["rev", "rev"], ["idle", "空闲"]],
        );
      }
      case "inspect": {
        const [roleId, stageName] = rest;
        if (!roleId || !stageName) return "用法：inspect <role> <stageName>";
        const r = await directorRoundtrip(opts, "inspect", [roleId, stageName]);
        if (!r.ok) return `✗ ${r.error}`;
        return JSON.stringify(r.result, null, 2);
      }
      case "call": {
        const [roleId, stageName, method, argsJson] = rest;
        if (!roleId || !stageName || !method) return "用法：call <role> <stageName> <method> [argsJSON]";
        let args: unknown[] = [];
        if (argsJson !== undefined) {
          try {
            args = JSON.parse(argsJson);
          } catch {
            return "✗ argsJSON 不是合法 JSON";
          }
          if (!Array.isArray(args)) return "✗ argsJSON 必须是数组";
        }
        const r = await directorRoundtrip(opts, "invoke", [roleId, stageName, method, args]);
        if (!r.ok) return `✗ ${r.error}`;
        return JSON.stringify(r.result, null, 2);
      }
      case "off": {
        const [roleId, stageName] = rest;
        if (!roleId || !stageName) return "用法：off <role> <stageName>";
        const r = await directorRoundtrip(opts, "off", [roleId, stageName]);
        return r.ok ? `✓ ${roleId}/${stageName} 已下场（排空 → offStage → 保存）` : `✗ ${r.error}`;
      }
      case "cues": {
        const r = await directorRoundtrip(opts, "cues", []);
        if (!r.ok) return `✗ ${r.error}`;
        const cues = r.result as Array<{
          roleId: string; stageName: string; name: string; everyMs: number | null; nextDue: string;
        }>;
        if (opts.json) return JSON.stringify(cues, null, 2);
        if (cues.length === 0) return "（无持久提醒；form({ cues: true }) 启用）";
        return table(
          cues.map((c) => ({ ...c, every: c.everyMs ? `${c.everyMs}ms` : "一次性" })),
          [["roleId", "角色"], ["stageName", "stageName"], ["name", "名称"], ["every", "周期"], ["nextDue", "下次触发"]],
        );
      }
      case "ring": {
        const r = await directorRoundtrip(opts, "ring", []);
        if (!r.ok) return `✗ ${r.error}`;
        const d = r.result as { nodes: string[] };
        return opts.json ? JSON.stringify(d, null, 2) : d.nodes.join("\n");
      }
      default:
        return `未知命令 "${command}"。可用：status roster ps inspect call off cues ring（--to host:port --json --token）`;
    }
  })();
  console.log(out);
}

void main();
