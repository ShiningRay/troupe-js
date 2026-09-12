import { unwrapEnvelope } from "../core/envelope.js";
import { CallRejectedError } from "../core/errors.js";
import type { PropStore } from "../props/prop-store.js";
import type { ReminderRecord } from "../cues/cue-store.js";

/** Director 系统角色（DESIGN §11.1）：内省/管理通道。安全默认仅 loopback；
 * 远程访问要求 TROUPE_ADMIN_TOKEN（cluster 边缘校验）。 */
export interface DirectorDeps {
  selfAddr: string | null;
  members: string[];
  slots(): Array<Record<string, unknown>>;
  repertoire: string[];
  methodsOf(roleId: string): string[];
  invoke(roleId: string, stageName: string, method: string, args: unknown[]): Promise<unknown>;
  off(roleId: string, stageName: string): Promise<void>;
  cueList(): Promise<ReminderRecord[]>;
  propStore: PropStore;
  namespace: string;
  pid: number;
  startedAt: number;
}

export const DIRECTOR_METHODS = [
  "roster",
  "actors",
  "inspect",
  "invoke",
  "off",
  "cues",
  "ring",
] as const;

export type DirectorMethod = (typeof DIRECTOR_METHODS)[number];

export async function directorCall(method: string, args: unknown[], deps: DirectorDeps): Promise<unknown> {
  switch (method) {
    case "roster":
      return {
        self: deps.selfAddr ?? `local:${deps.pid}`,
        members: deps.selfAddr ? [deps.selfAddr, ...deps.members] : [`local:${deps.pid}`],
        pid: deps.pid,
        uptimeMs: Date.now() - deps.startedAt,
        node: process.version,
        namespace: deps.namespace,
        roles: deps.repertoire,
      };
    case "actors": {
      const filter = args[0] as { role?: string } | undefined;
      const slots = deps.slots();
      return (filter?.role ? slots.filter((s) => s.roleId === filter.role) : slots).map((s) => ({
        ...s,
        idleMs: s.idleMs === -1 ? null : s.idleMs,
      }));
    }
    case "inspect": {
      const [roleId, stageName] = args as [string, string];
      if (typeof roleId !== "string" || typeof stageName !== "string") {
        throw new CallRejectedError("inspect 需要 [roleId, stageName]", "whitelist", false);
      }
      const stored = await deps.propStore.read(deps.namespace, roleId, stageName);
      const slot = deps.slots().find((s) => s.roleId === roleId && s.stageName === stageName);
      return {
        roleId,
        stageName,
        slot: slot ?? null,
        committed: stored
          ? {
              props: unwrapEnvelope(stored.props).props,
              revision: stored.revision,
              schemaVersion: stored.schemaVersion,
            }
          : null,
      };
    }
    case "invoke": {
      const [roleId, stageName, method2, invokeArgs] = args as [string, string, string, unknown[]];
      if (
        typeof roleId !== "string" || typeof stageName !== "string" ||
        typeof method2 !== "string" || !Array.isArray(invokeArgs)
      ) {
        throw new CallRejectedError("invoke 需要 [roleId, stageName, method, args[]]", "whitelist", false);
      }
      let methods: string[];
      try {
        methods = deps.methodsOf(roleId);
      } catch (e) {
        throw new CallRejectedError(e instanceof Error ? e.message : String(e), "whitelist", false);
      }
      if (!methods.includes(method2)) {
        throw new CallRejectedError(
          `方法 "${method2}" 不在 ${roleId} 的 RPC 白名单：${methods.join(", ") || "（无）"}（§6.1）`,
          "whitelist",
          false,
        );
      }
      return deps.invoke(roleId, stageName, method2, invokeArgs);
    }
    case "off": {
      const [roleId, stageName] = args as [string, string];
      if (typeof roleId !== "string" || typeof stageName !== "string") {
        throw new CallRejectedError("off 需要 [roleId, stageName]", "whitelist", false);
      }
      await deps.off(roleId, stageName);
      return { ok: true };
    }
    case "cues":
      return (await deps.cueList()).map((r) => ({
        roleId: r.roleId,
        stageName: r.stageName,
        name: r.name,
        everyMs: r.everyMs,
        at: r.at,
        nextDue: new Date(r.nextDue).toISOString(),
        statusVersion: r.statusVersion,
        owner: r.owner,
      }));
    case "ring":
      return {
        nodes: deps.selfAddr ? [deps.selfAddr, ...deps.members] : [`local:${deps.pid}`],
      };
    default:
      throw new CallRejectedError(
        `未知 Director 方法 "${method}"（可用：${DIRECTOR_METHODS.join(", ")}）`,
        "whitelist",
        false,
      );
  }
}
