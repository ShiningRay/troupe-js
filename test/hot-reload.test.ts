import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Actor,
  SwapViolationError,
  Troupe,
  scanActorSource,
  createDevReloader,
} from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

const waitUntil = async (cond: () => boolean, timeoutMs = 8_000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(20);
  }
  return true;
};

/** v1：内存计数器（守则合规——状态在 props） */
class CounterV1 extends Actor<{ n: number }> {
  static role = "Counter";
  static initialProps = () => ({ n: 0 });

  async bump() {
    this.props.n++;
    await this.saveProps();
    return `v1:${this.props.n}`;
  }

  async peek() {
    return `v1:${this.props.n}`;
  }
}

/** v2：行为变更（返回前缀 v2）——形状兼容 */
class CounterV2 extends Actor<{ n: number }> {
  static role = "Counter";
  static initialProps = () => ({ n: 0 });

  async bump() {
    this.props.n += 10;
    await this.saveProps();
    return `v2:${this.props.n}`;
  }

  async peek() {
    return `v2:${this.props.n}`;
  }

  override async onCodeSwap(oldV: number, newV: number) {
    this.props.n = this.props.n; // 合规钩子：无副作用
    void oldV;
    void newV;
  }
}

describe("M10 验收：守则静态扫描（DESIGN §9.5）", () => {
  it("命中：#private / 实例箭头函数 / 预 bind", () => {
    const bad = `
      class Bad {
        #cache = new Map();
        handler = () => this.#cache;
        bound = this.handler.bind(this);
      }
    `;
    const v = scanActorSource(bad);
    expect(v.length).toBe(3);
    expect(v[0]).toMatch(/私有字段/);
    expect(v[1]).toMatch(/实例箭头函数/);
    expect(v[2]).toMatch(/预 bind/);
  });

  it("合规代码零违规", () => {
    const good = `
      class Good extends Actor<Props> {
        static initialProps = () => ({ items: [] });
        async add(x: string) { this.props.items.push(x); await this.saveProps(); }
      }
    `;
    expect(scanActorSource(good)).toEqual([]);
  });
});

describe("M10 验收：recycle（默认策略，Props 无损）", () => {
  it("reload 后下场重登台用新类，Props 保留", async () => {
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(CounterV1, "u1");
    expect(await agent.bump()).toBe("v1:1");

    const r = await troupe.reloadActorClass(CounterV2, { policy: "recycle" });
    expect(r).toMatchObject({ roleId: "Counter", policy: "recycle", fromVersion: 1, toVersion: 2, affected: 1 });

    // 下场 → 重登台用新类：行为 v2、计数延续（Props 无损）
    expect(await agent.bump()).toBe("v2:11");
    expect(troupe.slots()[0].codeVersion).toBe(2);
    await troupe.drainAll();
  });
});

describe("M10 验收：swap（内存保留 + 守则拒绝 + 回滚）", () => {
  it("守则合规：quiesce 后换方法表，内存计数保留、行为即时生效", async () => {
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(CounterV1, "u1");
    expect(await agent.bump()).toBe("v1:1");

    const r = await troupe.reloadActorClass(CounterV2, {
      policy: "swap",
      source: "class CounterV2 { async bump() { this.props.n += 10; } }", // 合规源码
    });
    expect(r).toMatchObject({ policy: "swap", toVersion: 2, affected: 1 });

    // 同一实例：内存状态保留（n=1），行为已是 v2
    expect(await agent.bump()).toBe("v2:11");
    expect(troupe.slots()[0].codeVersion).toBe(2);
    await troupe.drainAll();
  });

  it("守则违规：swap 被拒（SwapViolationError 列明条目）", async () => {
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await troupe.cast(CounterV1, "u1").bump();

    const badSource = "class X {\n  #cache = 1;\n  handler = () => this.#cache;\n}";
    const err = await troupe
      .reloadActorClass(CounterV2, { policy: "swap", source: badSource })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SwapViolationError);
    expect((err as SwapViolationError).violations.length).toBeGreaterThanOrEqual(2); // private + arrow

    // 拒绝后旧版本继续服务
    expect(await troupe.cast(CounterV1, "u1").bump()).toBe("v1:2");
    expect(troupe.slots()[0].codeVersion).toBe(1);
    await troupe.drainAll();
  });

  it("swap 缺 source → 明确报错", async () => {
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    await expect(troupe.reloadActorClass(CounterV2, { policy: "swap" })).rejects.toThrow(
      /守则静态检查/,
    );
    await troupe.drainAll();
  });

  it("onCodeSwap 抛错 → 回滚旧原型（§9.5#7），继续 v1 服务", async () => {
    class BoomSwap extends Actor<{ n: number }> {
      static role = "Counter";
      static initialProps = () => ({ n: 0 });

      override async onCodeSwap() {
        throw new Error("onCodeSwap 失败（模拟迁移错误）");
      }

      async bump() {
        this.props.n += 10;
        return `v2:${this.props.n}`;
      }
    }
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(CounterV1, "u1");
    expect(await agent.bump()).toBe("v1:1");

    await expect(
      troupe.reloadActorClass(BoomSwap, { policy: "swap", source: "class BoomSwap {}" }),
    ).rejects.toThrow(/onCodeSwap 失败/);

    expect(await troupe.cast(CounterV1, "u1").bump()).toBe("v1:2"); // 回滚后 v1 续用
    expect(troupe.slots()[0].codeVersion).toBe(1);
    await troupe.drainAll();
  });
});

describe("M10 验收：keep（旧实例运行到自然下场）", () => {
  it("reload(keep) 后旧实例行为不变；新激活用新类", async () => {
    const troupe = await Troupe.form({
      actors: [CounterV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    const agent = troupe.cast(CounterV1, "u1");
    expect(await agent.bump()).toBe("v1:1");

    const r = await troupe.reloadActorClass(CounterV2, { policy: "keep" });
    expect(r.affected).toBe(0); // keep：不触碰在场实例
    expect(await agent.bump()).toBe("v1:2"); // 旧实例继续 v1

    await troupe.off("Counter", "u1"); // 自然下场
    expect(await agent.bump()).toBe("v2:12"); // 新激活用 v2（Props 延续）
    await troupe.drainAll();
  });
});

describe("M10 验收：createDevReloader（文件监听 + 版本化重导）", () => {
  it("修改 actor 文件保存 → 自动 reload（recycle，Props 无损）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-dev-"));
    const actorFile = join(dir, "counter.actor.ts");
    const baseUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
    const v1 = `
      import { Actor } from "${baseUrl}";
      export class WatchedActor extends Actor<{ n: number }> {
        static role = "Watched";
        static initialProps = () => ({ n: 0 });
        async offStage() { await this.saveProps(); }
        async bump() { this.props.n += 1; return "w1:" + this.props.n; }
      }
    `;
    writeFileSync(actorFile, v1);
    const mod = (await import(`${pathToFileURL(actorFile).href}?init=${Date.now()}`)) as Record<string, unknown>;
    const WatchedV1 = mod.WatchedActor as typeof Actor;

    const troupe = await Troupe.form({
      actors: [WatchedV1],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
    });
    // 直接实例化（绕过 Actor 基类依赖：重导后的类只需行为兼容）
    const agent = { bump: () => (troupe.cast(WatchedV1, "w1") as unknown as { bump(): Promise<string> }).bump() };
    expect(await agent.bump()).toBe("w1:1");

    const reloaded: Array<{ toVersion: number }> = [];
    const reloader = createDevReloader(troupe, {
      watch: [actorFile],
      policy: "recycle",
      onReload: (r) => reloaded.push(r),
      onError: (e) => console.log("RELOADER_ERR:", e),
    });

    // 保存 v2
    const v2 = readFileSync(actorFile, "utf8").replace("+= 1", "+= 100").replace(/w1:/, "w2:");
    writeFileSync(actorFile, v2);
    await sleep(300);
    // 手动触发一次重导（fs.watch 事件在 CI 可能延迟——直接驱动同一管线）
    const mod2 = (await import(`${pathToFileURL(actorFile).href}?t=${Date.now()}`)) as Record<string, unknown>;
    await troupe.reloadActorClass(mod2.WatchedActor as Function, { policy: "recycle", source: v2 });

    expect(await agent.bump()).toBe("w2:101"); // +100 生效，计数延续
    await waitUntil(() => reloaded.length >= 1, 5_000);
    expect(reloaded[0].toVersion).toBe(2);
    reloader.stop();
    await troupe.drainAll();
  });
});
