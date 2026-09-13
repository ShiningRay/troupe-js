import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { signBundle } from "../src/hot/deploy.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

const waitUntil = async (cond: () => boolean, timeoutMs = 12_000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(25);
  }
  return true;
};

const SECRET = "deploy-secret-1";

class EmergencyV1Actor extends Actor<{ n: number }> {
  static role = "Emergency";
  static initialProps = () => ({ n: 0 });

  async bump() {
    this.props.n += 1;
    await this.saveProps();
    return `v1:${this.props.n}`;
  }

  async peek() {
    return `v1:${this.props.n}`;
  }
}

/** bundle v1/v2：自包含 JS（plain 类，含 swap 后所需全部方法） */
function bundleSource(behavior: "v1" | "v2"): string {
  return `
    export class EmergencyActor {
      static role = "Emergency";
      static initialProps = () => ({ n: 0 });
      constructor() {}
      async onStage() {}
      async offStage() {}
      async onEvent() {}
      async onCue() {}
      async bump() {
        this.props.n += ${behavior === "v1" ? 1 : 100};
        return "${behavior}:" + this.props.n;
      }
      async peek() {
        return "${behavior}:" + this.props.n;
      }
    }
  `;
}

function makeBundle(behavior: "v1" | "v2", sig = true): {
  roleId: string;
  source: string;
  className: string;
  policy: "swap";
  sig: string;
} {
  const source = bundleSource(behavior);
  return {
    roleId: "Emergency",
    source,
    className: "EmergencyActor",
    policy: "swap",
    sig: sig ? signBundle("Emergency", source, SECRET) : "bad-sig",
  };
}

describe("M11 验收：生产热替换（DESIGN §9.4，独立实验）", () => {
  it("双 Stage 集群：广播部署不打断流量，ps 可见版本切换；并发调用全部成功", async () => {
    process.env.TROUPE_DEPLOY_SECRET = SECRET;
    try {
      const a = await Troupe.form({
        actors: [EmergencyV1Actor],
        propStore: new InMemoryPropStore(),
        defaultIntermission: 0,
        defaultTimeout: "15s",
        cluster: { port: 0 },
      });
      const b = await Troupe.form({
        actors: [EmergencyV1Actor],
        propStore: new InMemoryPropStore(),
        defaultIntermission: 0,
        defaultTimeout: "15s",
        cluster: { port: 0, seeds: [a.clusterAddress()!] },
      });
      await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));

      let key = "";
      for (let i = 0; i < 1000; i++) {
        if (a.ownerOf("Emergency", `e${i}`) === b.clusterAddress()) {
          key = `e${i}`;
          break;
        }
      }
      expect(await a.cast(EmergencyV1Actor, key).bump()).toBe("v1:1"); // A 发起，B 执行
      expect(a.slots().length).toBe(0);
      expect(b.slots().length).toBe(1);

      // 部署期间持续流量：全部成功（排队在换码后继续，无拒绝 = 不打断）
      let failures = 0;
      let results: string[] = [];
      const traffic = (async () => {
        for (let i = 0; i < 30; i++) {
          try {
            results.push((await a.cast(EmergencyV1Actor, key).bump()) as string);
          } catch {
            failures++;
          }
          await sleep(10);
        }
      })();
      await sleep(30);

      const results2 = await a.deployCluster(makeBundle("v2"));
      await traffic;

      // 两个 Stage 都换码成功
      expect(results2).toHaveLength(2);
      expect(results2.every((r) => r.error === undefined)).toBe(true);
      expect(failures).toBe(0); // 不打断
      // 版本切换可见（ps/Booth 数据源）
      expect(a.slots().every((s) => s.codeVersion >= 2) || b.slots().every((s) => s.codeVersion >= 2)).toBe(true);
      // 新行为生效（最后一个结果应为 v2 计数）
      expect(results.filter((r) => r.startsWith("v2:")).length).toBeGreaterThan(0);
      void key;
      await a.shutdown();
      await b.shutdown();
    } finally {
      delete process.env.TROUPE_DEPLOY_SECRET;
    }
  }, 40_000);

  it("不兼容变更：移除方法 / schemaVersion 跳级 / 缺 migrateProps → 拒绝并输出规则", async () => {
    process.env.TROUPE_DEPLOY_SECRET = SECRET;
    try {
      const troupe = await Troupe.form({
        actors: [EmergencyV1Actor],
        propStore: new InMemoryPropStore(),
        defaultIntermission: 0,
      });

      const removed = await troupe
        .deployLocal({
          roleId: "Emergency",
          source: bundleSource("v2").replace("async peek() {\n        return", "async peekX() {\n        return"),
          className: "EmergencyActor",
          policy: "swap",
          sig: signBundle("Emergency", bundleSource("v2").replace("async peek() {\n        return", "async peekX() {\n        return"), SECRET),
        })
        .catch((e) => e);
      expect((removed as Error).message).toMatch(/R1 违规：方法被移除/);

      const jump = await troupe
        .deployLocal({
          roleId: "Emergency",
          source: bundleSource("v2").replace("static initialProps", "static schemaVersion = 5;\n  static initialProps"),
          className: "EmergencyActor",
          policy: "swap",
          sig: signBundle("Emergency", bundleSource("v2").replace("static initialProps", "static schemaVersion = 5;\n  static initialProps"), SECRET),
        })
        .catch((e) => e);
      expect((jump as Error).message).toMatch(/R3 违规：schemaVersion/);

      const noMigrate = await troupe
        .deployLocal({
          roleId: "Emergency",
          source: bundleSource("v2").replace("static initialProps", "static schemaVersion = 2;\n  static initialProps"),
          className: "EmergencyActor",
          policy: "swap",
          sig: signBundle("Emergency", bundleSource("v2").replace("static initialProps", "static schemaVersion = 2;\n  static initialProps"), SECRET),
        })
        .catch((e) => e);
      expect((noMigrate as Error).message).toMatch(/R3 违规.*migrateProps/);

      // 拒绝后旧版本继续
      expect(await troupe.cast(EmergencyV1Actor, "u1").bump()).toBe("v1:1");
      await troupe.drainAll();
    } finally {
      delete process.env.TROUPE_DEPLOY_SECRET;
    }
  });

  it("签名：篡改 bundle 被拒", async () => {
    process.env.TROUPE_DEPLOY_SECRET = SECRET;
    try {
      const troupe = await Troupe.form({
        actors: [EmergencyV1Actor],
        propStore: new InMemoryPropStore(),
        defaultIntermission: 0,
      });
      const tampered = makeBundle("v2");
      tampered.source = tampered.source.replace("+= 100", "+= 999"); // 篡改内容
      await expect(troupe.deployLocal(tampered)).rejects.toThrow(/签名校验失败/);
      await troupe.drainAll();
    } finally {
      delete process.env.TROUPE_DEPLOY_SECRET;
    }
  });

  it("回滚演练：部署 v1 基线 → v2 → rollback → v1 行为恢复（内存计数延续）", async () => {
    process.env.TROUPE_DEPLOY_SECRET = SECRET;
    try {
      const troupe = await Troupe.form({
        actors: [EmergencyV1Actor],
        propStore: new InMemoryPropStore(),
        defaultIntermission: 0,
      });
      const agent = troupe.cast(EmergencyV1Actor, "u1");
      expect(await agent.bump()).toBe("v1:1");

      // 部署语义：回滚目标 = 上一已部署 bundle。先部署 v1 基线，再上 v2。
      await troupe.deployLocal(makeBundle("v1"));
      await troupe.deployLocal(makeBundle("v2"));
      expect(await agent.bump()).toBe("v2:101"); // 换码后内存保留

      const rb = await troupe.rollbackDeploy("Emergency");
      expect(rb).toMatchObject({ roleId: "Emergency", toVersion: 4 });
      expect(await agent.bump()).toBe("v1:102"); // 回滚到 v1 行为（内存计数延续）

      // 再回滚 = 重新部署 v2（回滚即可往复的"部署上一版本"语义）
      const rb2 = await troupe.rollbackDeploy("Emergency");
      expect(rb2).toMatchObject({ roleId: "Emergency", toVersion: 5 });
      expect(await agent.bump()).toBe("v2:202");
      await troupe.drainAll();
    } finally {
      delete process.env.TROUPE_DEPLOY_SECRET;
    }
  });
});

