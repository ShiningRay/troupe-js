import { describe, expect, it } from "vitest";
import { Actor, Improv, ReadOnly, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { sleep } from "./helpers.js";

const waitUntil = async (cond: () => boolean, timeoutMs = 6_000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(10);
  }
  return true;
};

let readMax = 0;
let readInflight = 0;
const readGate = { open: false };

let improvMax = 0;
let improvInflight = 0;
const improvGate = { open: false };

/** 交错矩阵目标：readOnly×readOnly、improv×readOnly、improv×improv 可交错；strict 独占 */
class MatrixActor extends Actor<{ log: string[] }> {
  static role = "Matrix";
  static initialProps = () => ({ log: [] });

  @ReadOnly
  async slowRead(gate: "open" | "instant") {
    readInflight++;
    readMax = Math.max(readMax, readInflight);
    if (gate === "open") {
      readGate.open = true;
      while (readGate.open) await sleep(10); // 等 `closeReads` 关闸
    } else {
      await sleep(40);
    }
    readInflight--;
    return "read";
  }

  @Improv // 关闸必须能与在飞请求交错（strict 会与"等关闸的读"互相等待）
  async closeReads() {
    readGate.open = false;
    return "closed";
  }

  @Improv
  async slowImprov(gate: "open" | "instant") {
    improvInflight++;
    improvMax = Math.max(improvMax, improvInflight);
    if (gate === "open") {
      improvGate.open = true;
      while (improvGate.open) await sleep(10);
    } else {
      await sleep(40);
    }
    improvInflight--;
    return "improv";
  }

  @Improv
  async closeImprov() {
    improvGate.open = false;
    return "closed";
  }

  async slowStrict() {
    // 未标注：独占——执行期间任何 annotated 都不得开始
    const before = { readInflight, improvInflight };
    await sleep(60);
    // 执行全程无并发（读/即在飞数在进入时为 0，结束后读仍为 0）
    return { before, after: { readInflight, improvInflight } };
  }
}

class StarveActor extends Actor<{ n: number }> {
  static role = "Starve";
  static initialProps = () => ({ n: 0 });

  @ReadOnly
  async read() {
    await sleep(20);
    return this.props.n;
  }

  async write() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

/** 中间态可见性：@Improv 写方法的 await 窗口对另一 @Improv 读可见（§5.4 文档语义） */
class TransferActor extends Actor<{ balance: number; audit: string[] }> {
  static role = "Transfer";
  static initialProps = () => ({ balance: 100, audit: [] });

  @Improv
  async withdraw(amount: number) {
    if (this.props.balance < amount) return "insufficient";
    this.props.balance -= amount; // 中间态：扣减已可见、审计未写
    await sleep(60); // 交错窗口
    const observed = this.props.balance;
    this.props.audit.push(`-${amount}@${observed}`);
    await this.saveProps();
    return "ok";
  }

  @Improv
  async peek() {
    return this.props.balance;
  }
}

describe("M5 验收：交错执行组合矩阵（DESIGN §5.4）", () => {
  it("readOnly×readOnly 交错；strict（closeReads）等待全部读结束", async () => {
    readMax = 0;
    readInflight = 0;
    readGate.open = false;
    const troupe = await Troupe.form({
      actors: [MatrixActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(MatrixActor, "m1");
    const r1 = agent.slowRead("open");
    await waitUntil(() => readGate.open);
    const r2 = agent.slowRead("instant"); // 读×读：立即交错
    await r2;
    expect(readMax).toBe(2);
    const close = await agent.closeReads(); // @Improv：与在飞读交错关闸
    expect(close).toBe("closed");
    expect(await r1).toBe("read");
    expect(readInflight).toBe(0);
    await troupe.drainAll();
  });

  it("improv×readOnly / improv×improv 交错", async () => {
    improvMax = 0;
    improvInflight = 0;
    improvGate.open = false;
    readMax = 0;
    readInflight = 0;
    readGate.open = false;
    const troupe = await Troupe.form({
      actors: [MatrixActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(MatrixActor, "m2");
    const i1 = agent.slowImprov("open");
    await waitUntil(() => improvGate.open);
    const r1 = agent.slowRead("instant"); // readOnly 与在飞 @Improv 交错
    await r1;
    expect(readMax).toBeGreaterThanOrEqual(1); // r1 确实执行过（与 @Improv 同期交错）
    expect(improvInflight).toBe(1); // i1 仍在门闩循环中
    const i2 = agent.slowImprov("instant"); // improv×improv
    await i2;
    expect(improvMax).toBe(2); // 与 i1 同期在飞
    await agent.closeImprov();
    expect(await i1).toBe("improv");
    expect(improvInflight).toBe(0);
    await troupe.drainAll();
  });

  it("strict 独占：执行期间 annotated 不得开始（未标注与任何调用不交错）", async () => {
    const troupe = await Troupe.form({
      actors: [MatrixActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(MatrixActor, "m3");
    const strict = agent.slowStrict();
    await sleep(10);
    const read = agent.slowRead("instant"); // 排队等 strict
    const improv = agent.slowImprov("instant");
    const out = await strict;
    expect(out.before).toEqual({ readInflight: 0, improvInflight: 0 });
    expect(out.after).toEqual({ readInflight: 0, improvInflight: 0 }); // strict 执行全程无并发
    await read;
    await improv;
    await troupe.drainAll();
  });
});

describe("M5 验收：写饥饿防护", () => {
  it("strict 写入队后，新读停止启动；写在有界时间内获得执行", async () => {
    const troupe = await Troupe.form({
      actors: [StarveActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(StarveActor, "s1");

    let readCompletions = 0;
    let stopReads = false;
    const readStream = (async () => {
      while (!stopReads) {
        await agent.read();
        readCompletions++;
      }
    })();

    await sleep(100); // 读流跑起来（每次 20ms，多次交错）
    const writeStart = Date.now();
    const write = agent.write(); // strict 入队：防饿规则生效
    await write;
    const writeWaitMs = Date.now() - writeStart;

    stopReads = true;
    await readStream;
    expect(writeWaitMs).toBeLessThan(500); // 写未被读流饿死（有界等待）
    expect(readCompletions).toBeGreaterThan(2); // 读确实发生过
    expect(await agent.write()).toBe(2); // 框架继续可用
    await troupe.drainAll();
  }, 15_000);
});

describe("M5 验收：quiesce 等待全部在飞请求（§5.2）", () => {
  it("交错开启时 drainAll 等所有并发请求 settle（含被调用方超时后仍占位的执行）", async () => {
    improvMax = 0;
    improvInflight = 0;
    improvGate.open = false;
    const troupe = await Troupe.form({
      actors: [MatrixActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(MatrixActor, "q1");
    const i1 = agent.slowImprov("open");
    await waitUntil(() => improvGate.open);
    const i2 = agent.slowImprov("instant"); // 第二个并发在飞
    await sleep(30); // 等 pump 微任务启动 i2
    expect(improvInflight).toBe(2);

    const drained = troupe.drainAll(); // quiesce：等全部在飞（不中断、不卸载）
    await i2; // 短请求在排空中自然完成
    await sleep(50);
    expect(improvInflight).toBe(1); // i1（门闩循环）仍被 quiesce 等待、未被强杀
    improvGate.open = false; // 直接关闸（排空中 enqueue 被拒，不经 RPC）
    await drained;
    expect(improvInflight).toBe(0);
    expect(await i1).toBe("improv");
    expect(await i2).toBe("improv");
    expect(troupe.slots().length).toBe(0);
  });
});

describe("M5 验收：交错窗口的中间态可见（§5.4 文档语义）", () => {
  it("@Improv 写的 await 窗口对另一 @Improv 读可见（扣减已见、审计未写）", async () => {
    const troupe = await Troupe.form({
      actors: [TransferActor],
      propStore: new InMemoryPropStore(),
      defaultIntermission: 0,
      defaultTimeout: "10s",
    });
    const agent = troupe.cast(TransferActor, "t1");
    const w = agent.withdraw(30); // balance 100→70（中间态），审计窗口 60ms
    await sleep(20);
    const mid = await agent.peek(); // 交错读：看到中间态
    expect(mid).toBe(70);
    expect(await w).toBe("ok");
    // 完成后最终态一致；强制下场重载验证已持久化
    await troupe.off("Transfer", "t1");
    expect(await agent.peek()).toBe(70);
    await troupe.drainAll();
  });
});
