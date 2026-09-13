import { describe, expect, it } from "vitest";
import {
  Actor,
  Improv,
  Performs,
  RoleConflictError,
  Troupe,
  UnknownRoleError,
  type TroupeEvent,
} from "../src/index.js";
import { Rehearsal } from "../src/testing/index.js";
import { sleep } from "./helpers.js";

// 装饰器注册：import 即入团（进程级注册表）
@Performs("RegCart")
class RegCartActor extends Actor<{ items: string[] }> {
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
  }

  async peek() {
    return this.props.items.length;
  }
}

// 静态字段等价物：没有注册副作用，必须显式 form({ actors })
class StaticCartActor extends Actor<{ items: string[] }> {
  static role = "StaticCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
  }

  async peek() {
    return this.props.items.length;
  }
}

class DupAActor extends Actor<Record<string, never>> {
  static role = "Dup";
  static initialProps = () => ({}) as Record<string, never>;
  async ping() {
    return "a";
  }
}

class DupBActor extends Actor<Record<string, never>> {
  static role = "Dup";
  static initialProps = () => ({}) as Record<string, never>;
  async ping() {
    return "b";
  }
}

let improvOrder: string[] = [];

class ImprovCartActor extends Actor<{ n: number }> {
  static role = "ImprovCart";
  static initialProps = () => ({ n: 0 });

  @Improv // M1：标注了也按严格串行执行并告警（DESIGN §5.4）
  async slowPeek() {
    improvOrder.push("peek-start");
    await sleep(20);
    improvOrder.push("peek-end");
    return this.props.n;
  }

  async bump() {
    improvOrder.push("bump");
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

describe("M1 验收：注册双轨与 Repertoire（DESIGN §3.2/§8.3）", () => {
  it("静态字段类经 form({ actors }) 显式注册", async () => {
    const troupe = await Troupe.form({ actors: [StaticCartActor] });
    expect(troupe.repertoire()).toContain("StaticCart");
    expect(troupe.repertoire()).not.toContain("RegCart"); // 显式列表不含进程注册表 → 隔离
    const agent = troupe.cast(StaticCartActor, "s1");
    await agent.add("x");
    expect(await agent.peek()).toBe(1);
    await troupe.drainAll();
  });

  it("装饰器注册 + form() 无参取快照；每个 Troupe 独立", async () => {
    const t1 = await Troupe.form();
    expect(t1.repertoire()).toContain("RegCart");
    const t2 = await Troupe.form({ actors: [StaticCartActor] });
    expect(t2.repertoire()).not.toContain("RegCart");
    await t1.drainAll();
    await t2.drainAll();
  });

  it("重复 roleId → 启动 fail fast（RoleConflictError）", async () => {
    await expect(Troupe.form({ actors: [DupAActor, DupBActor] })).rejects.toBeInstanceOf(
      RoleConflictError,
    );
  });

  it("cast 未注册字符串 → 同步 UnknownRoleError 并列出 Repertoire", async () => {
    const troupe = await Troupe.form({ actors: [StaticCartActor] });
    expect(() => troupe.cast("Nope", "x")).toThrowError(UnknownRoleError);
    expect(() => troupe.cast("Nope", "x")).toThrowError(/StaticCart/);
  });

  it("cast 未注册的类引用 → UnknownRoleError 含注册指引", async () => {
    class UnregisteredActor extends Actor<Record<string, never>> {
      static initialProps = () => ({}) as Record<string, never>;
      async ping() {
        return "pong";
      }
    }
    const troupe = await Troupe.form({ actors: [StaticCartActor] });
    expect(() => troupe.cast(UnregisteredActor, "x")).toThrowError(/未注册/);
    expect(() => troupe.cast(UnregisteredActor, "x")).toThrowError(UnknownRoleError);
  });
});

describe("M1 验收：Agent 表面（DESIGN §3.2）", () => {
  it("只暴露 RPC 白名单；then/Symbol 安全", async () => {
    const troupe = await Troupe.form({ actors: [StaticCartActor] });
    const agent = troupe.cast(StaticCartActor, "agent-1");

    expect("add" in agent).toBe(true);
    expect("then" in agent).toBe(false); // 不被当作 thenable
    const loose = agent as unknown as Record<PropertyKey, unknown>;
    expect(loose.props).toBeUndefined(); // Props 不可见
    expect(loose.onStage).toBeUndefined(); // 生命周期不可见
    expect(loose.saveProps).toBeUndefined(); // 运行时成员不可见
    expect(loose.nonexistent).toBeUndefined(); // 白名单外
    expect(loose[Symbol.toPrimitive]).toBeUndefined(); // Symbol 访问安全
    await agent.add("x");
    expect(await agent.peek()).toBe(1);
    await troupe.drainAll();
  });
});

describe("M5 语义：@Improv 交错交付后未标注方法仍独占", () => {
  it("未标注方法（bump）不与 @Improv 方法交错；无 M1 告警", async () => {
    improvOrder = [];
    const warnings: string[] = [];
    const troupe = await Troupe.form({
      actors: [ImprovCartActor],
      defaultIntermission: 0,
      onEvent: (e: TroupeEvent) => {
        if (e.type === "warn") warnings.push(String(e.detail?.message));
      },
    });
    expect(warnings.some((w) => w.includes("严格串行"))).toBe(false); // M1 告警已移除

    const agent = troupe.cast(ImprovCartActor, "im-1");
    const peekP = agent.slowPeek(); // @Improv，20ms
    await sleep(5);
    const bumpP = agent.bump(); // 未标注 = strict：与任何调用不交错
    await peekP;
    await bumpP;

    expect(improvOrder).toEqual(["peek-start", "peek-end", "bump"]);
    await troupe.drainAll();
  });
});

describe("M1 验收：NODE_ENV=test 零显式配置（DESIGN §8.2）", () => {
  it("NODE_ENV=test 下 form() 静默使用 InMemory（无 propStore 告警）", async () => {
    expect(process.env.NODE_ENV).toBe("test"); // vitest 默认注入
    const warnings: string[] = [];
    const troupe = await Troupe.form({
      onEvent: (e: TroupeEvent) => {
        if (e.type === "warn") warnings.push(String(e.detail?.message));
      },
    });
    expect(warnings.some((w) => w.includes("propStore"))).toBe(false);
    expect(troupe.repertoire()).toContain("RegCart"); // 装饰器注册表快照
    await troupe.drainAll();
  });

  it("Rehearsal：强制 InMemory 的测试集群", async () => {
    const rehearsal = await Rehearsal.form({ actors: [StaticCartActor] });
    const agent = rehearsal.cast(StaticCartActor, "re-1");
    await agent.add("x");
    expect(await agent.peek()).toBe(1);
    expect(rehearsal.metrics()["StaticCart"]?.calls).toBe(2);
    await rehearsal.drainAll();
  });
});
