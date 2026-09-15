import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, SqliteSubscriptionStore, Troupe } from "../src/index.js";
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

interface InboxProps {
  received: unknown[];
  failFirst: number;
}

class InboxActor extends Actor<InboxProps> {
  static role = "Inbox";
  static initialProps = (): InboxProps => ({ received: [], failFirst: 0 });

  override async onStage() {
    await this.subscribe("alerts");
  }

  override async onEvent(event: unknown) {
    // 模拟瞬时不可用：failFirst > 0 时前 N 次投递失败（业务侧拒绝）
    if (this.props.failFirst > 0) {
      this.props.failFirst--;
      throw new Error("transient-unavailable");
    }
    this.props.received.push(event);
    await this.saveProps();
  }

  async setFailFirst(n: number) {
    this.props.failFirst = n;
    await this.saveProps();
    return n;
  }

  async read() {
    return this.props.received;
  }
}

describe("M11+ 收尾：Show 持久订阅与至少一次投递", () => {
  it("coordinator 重启后订阅不丢（SQLite 重载），publish 直达未重新登台的订阅者", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-showpersist-"));
    const t1 = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0 },
      show: { persist: { dir } },
    });
    await t1.cast(InboxActor, "u1").read(); // 激活 → onStage 订阅（落盘）
    expect((await new SqliteSubscriptionStore(dir).list("default")).length).toBe(1);
    await t1.shutdown(); // coordinator 内存订阅目录消失

    // 新进程（同持久目录）：未重新 onStage，直接发布 → 持久订阅仍在
    const t2 = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0 },
      show: { persist: { dir } },
    });
    await waitUntil(async () => (await t2.director().cues instanceof Function));
    await t2.publish("alerts", { text: "after-restart" });

    expect(
      await waitUntil(async () =>
        ((await t2.cast(InboxActor, "u1").read()) as unknown[]).length > 0,
      ),
    ).toBe(true);
    expect(await t2.cast(InboxActor, "u1").read()).toEqual([{ text: "after-restart" }]);
    await t2.shutdown();
  }, 20_000);

  it("至少一次：投递失败退避重试（3 次内成功，不 drop）", async () => {
    const troupe = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "5s",
    });
    await troupe.cast(InboxActor, "u1").setFailFirst(2); // 前 2 次投递失败
    await troupe.cast(InboxActor, "u1").read(); // 激活+订阅

    let dropped = 0;
    const unsub = troupe.events.on((e) => {
      if (e.type === "showDropped") dropped++;
    });
    await troupe.publish("alerts", { n: 1 }); // 3 次尝试：败/败/成
    await sleep(100);
    unsub();

    expect(dropped).toBe(0); // 重试后成功，未 drop
    expect((await troupe.cast(InboxActor, "u1").read()).length).toBe(1);
    await troupe.drainAll();
  }, 15_000);

  it("持续失败 → 最终 drop（事件记录），消息不阻塞发布方", async () => {
    const troupe = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "5s",
    });
    await troupe.cast(InboxActor, "u1").setFailFirst(99); // 一直失败
    await troupe.cast(InboxActor, "u1").read();

    const dropped = (await new Promise<unknown[]>((resolve) => {
      const found: unknown[] = [];
      const unsub = troupe.events.on((e) => {
        if (e.type === "showDropped") found.push(e);
        if (found.length >= 1) {
          unsub();
          resolve(found);
        }
      });
      void troupe.publish("alerts", { n: 2 }).then(() => {
        setTimeout(() => resolve(found), 200);
      });
    })) as unknown[];
    expect(dropped.length).toBe(1); // 3 次重试后放弃并记录
    await troupe.drainAll();
  }, 15_000);

  it("退订同步删除持久化记录：重启后发布零投递", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-showpersist2-"));
    const t1 = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0 },
      show: { persist: { dir } },
    });
    await t1.cast(InboxActor, "u1").read();
    expect((await new SqliteSubscriptionStore(dir).list("default")).length).toBe(1);
    // 退订（手动构造 Audience 通道）
    await t1.unsubscribe("alerts", { roleId: "Inbox", stageName: "u1", method: "onEvent" });
    expect((await new SqliteSubscriptionStore(dir).list("default")).length).toBe(0);
    await t1.shutdown();

    const t2 = await Troupe.form({
      actors: [InboxActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      cluster: { port: 0 },
      show: { persist: { dir } },
    });
    // 不激活（订阅已删，且重载不会恢复）
    await t2.publish("alerts", { text: "should-not-arrive" });
    await sleep(150);
    expect((await t2.cast(InboxActor, "u1").read()).length).toBe(0);
    await t2.shutdown();
  }, 20_000);
});
