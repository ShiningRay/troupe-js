import { describe, expect, it } from "vitest";
import { unwrapEnvelope, wrapEnvelope } from "../src/core/envelope.js";
import { ActivationError, Actor, ConflictError, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";

interface CartProps {
  items: string[];
}

class Cart2Actor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
  }

  async peek() {
    return this.props.items.length;
  }
}

/** 写入可注入失败的存储（测试注入接口） */
class FlakyStore extends InMemoryPropStore {
  failNextWrite = false;

  override async write(
    ...args: Parameters<InMemoryPropStore["write"]>
  ): ReturnType<InMemoryPropStore["write"]> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("disk on fire");
    }
    return super.write(...args);
  }
}

describe("M1 验收：保存失败与 CAS 冲突（DESIGN §7.2/§7.3）", () => {
  it("保存失败 → 实例失效；下次调用从最后已提交快照继续（不基于未提交状态运行）", async () => {
    const store = new FlakyStore();
    const troupe = await Troupe.form({ actors: [Cart2Actor], propStore: store, defaultIntermission: 0 });
    const cart = troupe.cast(Cart2Actor, "u1");

    await cart.add("one"); // create 成功（revision 1）
    store.failNextWrite = true;
    await expect(cart.add("two")).rejects.toThrowError("disk on fire");

    // 失效后的重新激活不包含未提交的 "two"
    expect(await cart.peek()).toBe(1);
    await cart.add("three");
    expect(await cart.peek()).toBe(2);
    await troupe.drainAll();
  });

  it("CAS 冲突抛 ConflictError 且实例失效；重载外部版本", async () => {
    const store = new InMemoryPropStore();
    const troupe = await Troupe.form({ actors: [Cart2Actor], propStore: store, defaultIntermission: 0 });
    const cart = troupe.cast(Cart2Actor, "u1");
    await cart.add("one"); // revision 1

    // 外部写入（模拟另一持有者/手工运维）：bump revision 并修改内容
    const rec = (await store.read("default", "Cart2", "u1"))!;
    const { props: userProps } = unwrapEnvelope(rec.props);
    (userProps as CartProps).items.push("external");
    await store.write("default", "Cart2", "u1", wrapEnvelope(userProps, {}), {
      expectedRevision: rec.revision,
      schemaVersion: 1,
    });

    // actor 内存中仍持有 revision 1 → CAS 冲突 → 失效
    await expect(cart.add("two")).rejects.toBeInstanceOf(ConflictError);

    // 失效后重载外部提交的版本
    expect(await cart.peek()).toBe(2); // one + external
    await cart.add("three");
    expect(await cart.peek()).toBe(3);
    await troupe.drainAll();
  });
});

describe("M1 验收：schemaVersion 驱动迁移（DESIGN §7.4）", () => {
  it("低版本记录逐级迁移后登台", async () => {
    const store = new InMemoryPropStore();
    // 种子：v1 形态 { names: [...] }
    await store.create("default", "Legacy", "u1", wrapEnvelope({ names: ["a", "b"] }, {}), 1);

    class LegacyActor extends Actor<{ version: number; items: string[] }> {
      static schemaVersion = 2;
      static initialProps = () => ({ version: 2, items: [] });

      override async migrateProps(stored: unknown, fromVersion: number) {
        if (fromVersion === 1) {
          const old = stored as { names?: string[] };
          return { version: 2, items: old.names ?? [] };
        }
        return stored as { version: number; items: string[] };
      }

      async items() {
        return this.props.items;
      }
    }

    const troupe = await Troupe.form({ actors: [LegacyActor], propStore: store, defaultIntermission: 0 });
    const agent = troupe.cast(LegacyActor, "u1");
    expect(await agent.items()).toEqual(["a", "b"]);
    await troupe.drainAll();
  });

  it("迁移失败 → 激活失败（不进场服务），报角色+stageName+schemaVersion", async () => {
    const store = new InMemoryPropStore();
    await store.create("default", "BadMig", "u1", wrapEnvelope({}, {}), 1);

    class BadMigActor extends Actor<Record<string, never>> {
      static schemaVersion = 2;
      static initialProps = () => ({}) as Record<string, never>;

      override async migrateProps(): Promise<Record<string, never>> {
        throw new Error("no route");
      }

      async ping() {
        return "pong";
      }
    }

    const troupe = await Troupe.form({ actors: [BadMigActor], propStore: store, defaultIntermission: 0 });
    const agent = troupe.cast(BadMigActor, "u1");
    const outcome = await agent.ping().catch((e) => e);
    expect(outcome).toBeInstanceOf(ActivationError);
    expect((outcome as ActivationError).message).toContain("schemaVersion 1→2");
  });
});
