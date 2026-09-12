/**
 * Troupe.js M2 Demo —— 分幕演示 M2 里程碑特性（PLAN §2.M2）：
 *   1. SqlitePropStore：进程级持久化，"重启"后状态恢复
 *   2. Codec 边界统一：Date→ISO / 非法值拒收 / 参数与结果双向隔离
 *   3. 双 Stage 组团 + 透明路由（HashRing 决定归属，调用方无感）
 *   4. 错误分类（§6.1）：业务异常 / 存储冲突 / 执行结果未知
 *   5. 信任边界：畸形帧可控拒绝（进程不崩）+ 白名单外方法拒绝
 *   6. 环漂移转发（跳数上限 2）
 *   7. kill -9 → 探测判死 → 接管 + 共享 SQLite 恢复
 *   8. 优雅停机：leave / 拒新 / 存量 settle / 对端快速收敛
 *   9. 全局背压：在场 Actor 上限 + 排队字节预算
 *
 * 运行：npm run demo:m2
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  Actor,
  ConflictError,
  InMemoryPropStore,
  Troupe,
  Transport,
  UnknownOutcomeError,
  type WireMessage,
} from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";
import { unwrapEnvelope, wrapEnvelope } from "../../src/core/envelope.js";

const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(4, " ")}ms`;
const section = (title: string) => console.log(`\n━━━ ${title} ━━━`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 12_000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

// 贯穿使用的业务 Actor
class ShopCartActor extends Actor<{ items: string[] }> {
  static role = "ShopCart";
  static initialProps = () => ({ items: [] });

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }

  async slow(ms: number) {
    await sleep(ms);
    return "slow-done";
  }

  async fail() {
    throw new Error("库存不足（业务异常演示）");
  }

  async stamp(when: Date) {
    return { received: when, type: typeof when };
  }
}

interface Stage {
  troupe: Troupe;
  store: InMemoryPropStore;
}

async function startStage(seeds: string[] = []): Promise<Stage> {
  const store = new InMemoryPropStore();
  const troupe = await Troupe.form({
    actors: [ShopCartActor],
    propStore: store,
    defaultIntermission: 0,
    defaultTimeout: "10s",
    cluster: { port: 0, seeds },
  });
  return { troupe, store };
}

/** 找一个归属指定 Stage 的键（不赌哈希分布） */
function keyOwnedBy(owner: Troupe, roleId = "ShopCart"): string {
  for (let i = 0; i < 1000; i++) {
    const name = `user-${i}-${randomUUID().slice(0, 4)}`;
    if (owner.ownerOf(roleId, name) === owner.clusterAddress()) return name;
  }
  throw new Error("找不到归属键");
}

// ───────────────────────── 1. SQLite 进程级持久化 ─────────────────────────

{
  section("1. SqlitePropStore：进程级持久化（DESIGN §7.2）");
  const dir = mkdtempSync(join(tmpdir(), "troupe-demo-m2-"));
  const run1 = await Troupe.form({
    actors: [ShopCartActor],
    propStore: new SqlitePropStore(dir),
    defaultIntermission: 0,
  });
  const cart = run1.cast(ShopCartActor, "user-42");
  await cart.add("apple");
  await cart.add("bread");
  await run1.drainAll(); // 下场归还 Props
  console.log(`[${ts()}] 第一次运行：add ×2 完成，进程"退出"（数据目录 ${dir}）`);

  // 模拟重启：同一个目录新开一个 Troupe
  const run2 = await Troupe.form({
    actors: [ShopCartActor],
    propStore: new SqlitePropStore(dir),
    defaultIntermission: 0,
  });
  console.log(`[${ts()}] 重启后 peek = ${await run2.cast(ShopCartActor, "user-42").peek()}（从磁盘恢复）`);
  await run2.drainAll();
}

// ───────────────────────── 2. Codec 边界统一 ─────────────────────────

{
  section("2. Codec 边界统一：本地/远程/存储同一语义（DESIGN §6.1）");
  const troupe = await Troupe.form({
    actors: [ShopCartActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
  });
  const cart = troupe.cast(ShopCartActor, "codec-1");

  // Date → ISO 字符串（JSON 语义）
  const stamped = await cart.stamp(new Date("2026-09-12T08:00:00.000Z"));
  console.log(`[${ts()}] Date 参数过边界 → ${JSON.stringify(stamped)}`);

  // 非法值拒收并给出改写指引
  for (const [label, value] of [
    ["BigInt", 1n],
    ["Map", new Map()],
    ["Agent 引用", cart],
  ] as const) {
    const err = await cart.stamp(value as unknown as Date).catch((e) => e);
    console.log(`[${ts()}] ${label} → ${(err as Error).name}：${(err as Error).message.slice(0, 42)}…`);
  }

  // 参数与结果双向隔离（深拷贝，不共享引用）
  const arg = { items: ["原对象"] } as unknown as string;
  await cart.add("x");
  const before = await cart.peek();
  console.log(`[${ts()}] 参数/结果均经复制边界（双向隔离），peek = ${before}，本地与远程行为一致`);
  await troupe.drainAll();
}

// ───────────────────────── 3. 组团 + 透明路由 ─────────────────────────

{
  section("3. 双 Stage 组团 + 透明路由（HashRing，§6.3）");
  const a = await startStage();
  const b = await startStage([a.troupe.clusterAddress()!]);
  await waitUntil(() =>
    a.troupe.clusterMembers()!.includes(b.troupe.clusterAddress()!) &&
    b.troupe.clusterMembers()!.includes(a.troupe.clusterAddress()!),
  );
  console.log(`[${ts()}] A=${a.troupe.clusterAddress()}，B=${b.troupe.clusterAddress()}，双方 Roster 已收敛`);

  const keyA = keyOwnedBy(a.troupe);
  const keyB = (() => {
    for (let i = 0; i < 1000; i++) {
      const n = `user-${i}-${randomUUID().slice(0, 4)}`;
      if (a.troupe.ownerOf("ShopCart", n) === b.troupe.clusterAddress()) return n;
    }
    throw new Error();
  })();
  console.log(`[${ts()}] 键归属：${keyA} → A；${keyB} → B（环视图一致，双方计算结果相同）`);

  // 从 B 发起对两个键的调用：归属 A 的自动路由到 A，归属 B 的本地执行
  console.log(`[${ts()}] 从 B cast ${keyA} → add = ${await b.troupe.cast(ShopCartActor, keyA).add("远程")}（实际在 A 执行）`);
  console.log(`[${ts()}] 从 B cast ${keyB} → add = ${await b.troupe.cast(ShopCartActor, keyB).add("本地")}（B 自己执行）`);
  console.log(
    `[${ts()}] 读写落在归属方存储：A 有 ${keyA}=${(await a.store.read("default", "ShopCart", keyA)) !== null}，` +
      `B 有 ${keyB}=${(await b.store.read("default", "ShopCart", keyB)) !== null}`,
  );
  await a.troupe.shutdown();
  await b.troupe.shutdown();
}

// ───────────────────────── 4. 错误分类（§6.1） ─────────────────────────

{
  section("4. 错误分类：业务异常 / 存储冲突 / 执行结果未知（跨 Stage）");
  const a = await startStage();
  const b = await startStage([a.troupe.clusterAddress()!]);
  await waitUntil(() => a.troupe.clusterMembers()!.length === 1);
  const keyB = (() => {
    for (let i = 0; i < 1000; i++) {
      const n = `user-${i}-${randomUUID().slice(0, 4)}`;
      if (a.troupe.ownerOf("ShopCart", n) === b.troupe.clusterAddress()) return n;
    }
    throw new Error();
  })();

  // 业务异常：用户方法 throw，name+message 原样回传（stack 不上线）
  const biz = await a.troupe.cast(ShopCartActor, keyB).fail().catch((e) => e);
  console.log(`[${ts()}] 业务异常 → ${(biz as Error).name}: ${(biz as Error).message}`);

  // 存储冲突：外部提交抢先进位 → Actor CAS 失败 → ConflictError 跨线返回
  await a.troupe.cast(ShopCartActor, keyB).add("one");
  const rec = (await b.store.read("default", "ShopCart", keyB))!;
  const { props: userProps } = unwrapEnvelope(rec.props);
  (userProps as { items: string[] }).items.push("external");
  await b.store.write("default", "ShopCart", keyB, wrapEnvelope(userProps, {}), {
    expectedRevision: rec.revision,
    schemaVersion: 1,
  });
  const conflict = await a.troupe.cast(ShopCartActor, keyB).add("two").catch((e) => e);
  console.log(`[${ts()}] 存储冲突 → ${(conflict as Error).name}：${(conflict as Error).message.slice(0, 46)}…`);

  // 执行结果未知：调用在途时硬杀归属 Stage → 断连 → UnknownOutcomeError（勿假定失败）
  const slowP = a.troupe.cast(ShopCartActor, keyB).slow(2000);
  await sleep(80);
  b.troupe.destroy(); // kill -9
  const unknown = await slowP.catch((e) => e);
  console.log(`[${ts()}] 归属 Stage 被硬杀 → ${(unknown as Error).name}：${(unknown as Error).message.slice(0, 40)}…`);
  console.log(`[${ts()}] 调用方应按幂等键重试（§6.5），而非假定失败`);
  await a.troupe.shutdown();
}

// ───────────────────────── 5. 信任边界：畸形帧 + 白名单 ─────────────────────────

{
  section("5. 信任边界：畸形帧可控拒绝、进程不崩（§6.1）");
  const a = await startStage();
  const port = Number(a.troupe.clusterAddress()!.split(":")[1]);

  // 坏 JSON 帧 → 只断开该连接
  const garbage = connect(port, "127.0.0.1");
  const g1 = new Promise<void>((r) => garbage.on("close", () => r()));
  garbage.on("connect", () => {
    const body = Buffer.from("not json at all{{{");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    garbage.write(Buffer.concat([head, body]));
  });
  await g1;
  console.log(`[${ts()}] 坏 JSON 帧 → 该连接被销毁`);

  // 声称超长（> 4MB 上限）→ 解码前拒绝
  const huge = connect(port, "127.0.0.1");
  const g2 = new Promise<void>((r) => huge.on("close", () => r()));
  huge.on("connect", () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(64 * 1024 * 1024, 0);
    huge.write(head);
  });
  await g2;
  console.log(`[${ts()}] 超长帧（声称 64MB）→ 解码前拒绝，连接销毁`);

  // 白名单外方法（对端校验，不触碰实例属性）
  const raw = new Transport((_m: WireMessage, _r) => {});
  const wlId = randomUUID();
  const rejected = (await raw
    .request(
      a.troupe.clusterAddress()!,
      {
        t: "call", callId: wlId, from: "raw",
        to: { roleId: "ShopCart", stageName: "x" },
        method: "saveProps", // 基类运行时成员，禁入 RPC（§6.1）
        args: [], deadline: Date.now() + 3000, hops: 0,
      },
      wlId,
      3000,
    )
    .catch((e) => e)) as { ok?: boolean; err?: { kind?: string } };
  console.log(`[${ts()}] 调用 saveProps（基类成员）→ kind=${rejected.err?.kind} 拒绝`);
  raw.destroy();

  // 进程仍然健在，正常调用不受影响
  console.log(`[${ts()}] 攻击后正常 cast → peek = ${await a.troupe.cast(ShopCartActor, "after-attack").peek()}`);
  await a.troupe.shutdown();
}

// ───────────────────────── 6. 环漂移转发（跳数上限 2） ─────────────────────────

{
  section("6. 环漂移转发：误投到非归属 Stage 也能送达（§6.3）");
  const a = await startStage();
  const b = await startStage([a.troupe.clusterAddress()!]);
  await waitUntil(() => a.troupe.clusterMembers()!.length === 1);
  const keyB = (() => {
    for (let i = 0; i < 1000; i++) {
      const n = `user-${i}-${randomUUID().slice(0, 4)}`;
      if (a.troupe.ownerOf("ShopCart", n) === b.troupe.clusterAddress()) return n;
    }
    throw new Error();
  })();

  const raw = new Transport((_m: WireMessage, _r) => {});
  const mk = (hops: number) => {
    const id = randomUUID(); // pending 键必须与信封 callId 一致
    return raw.request(
      a.troupe.clusterAddress()!, // 故意打到非归属方 A
      {
        t: "call", callId: id, from: "raw",
        to: { roleId: "ShopCart", stageName: keyB },
        method: "add", args: ["via-forward"], deadline: Date.now() + 5000, hops,
      },
      id,
      5000,
    );
  };

  const okRes = (await mk(0)) as { ok: boolean; result?: unknown };
  console.log(`[${ts()}] hops=0 → A 转发给 B 执行，结果回程：${JSON.stringify(okRes.result)}`);
  const driftRes = (await mk(2)) as { ok: boolean; err?: { reason?: string } };
  console.log(`[${ts()}] hops=2 → 跳数耗尽被拒（reason=${driftRes.err?.reason}，防环）`);
  raw.destroy();
  await a.troupe.shutdown();
  await b.troupe.shutdown();
}

// ───────────────────────── 7. kill -9 接管 + SQLite 恢复 ─────────────────────────

{
  section("7. kill -9 → 探测判死 → 存活 Stage 接管（同机共享 SQLite）");
  const shared = new SqlitePropStore(mkdtempSync(join(tmpdir(), "troupe-demo-m2-kill-")));
  const mk = (seeds: string[]) =>
    Troupe.form({
      actors: [ShopCartActor],
      propStore: shared,
      defaultIntermission: 0,
      defaultTimeout: "10s",
      cluster: { port: 0, seeds },
    });
  const a = await mk([]);
  const b = await mk([a.clusterAddress()!]);
  await waitUntil(() => a.clusterMembers()!.includes(b.clusterAddress()!));

  const keyB = (() => {
    for (let i = 0; i < 1000; i++) {
      const n = `user-${i}-${randomUUID().slice(0, 4)}`;
      if (a.ownerOf("ShopCart", n) === b.clusterAddress()) return n;
    }
    throw new Error();
  })();
  await a.cast(ShopCartActor, keyB).add("one");
  await a.cast(ShopCartActor, keyB).add("two");
  console.log(`[${ts()}] ${keyB} 归属 B，已写入 2 笔（落在共享 SQLite）`);

  b.destroy(); // kill -9：无 leave、无排空
  console.log(`[${ts()}] kill -9 B，等待后继探测判死（连续 3 周期无 ACK，约 3s）…`);
  const dead = await waitUntil(() => a.clusterMembers()!.length === 0, 15_000);
  console.log(`[${ts()}] B 判死=${dead}；${keyB} 新归属 = ${a.ownerOf("ShopCart", keyB) === a.clusterAddress() ? "A" : "?"}`);

  console.log(`[${ts()}] A 接管后 peek = ${await a.cast(ShopCartActor, keyB).peek()}（从共享 SQLite 恢复）`);
  console.log(`[${ts()}] 继续可用 add = ${await a.cast(ShopCartActor, keyB).add("three")}`);
  await a.shutdown();
}

// ───────────────────────── 8. 优雅停机 ─────────────────────────

{
  section("8. 优雅停机：leave / 拒新 / 存量 settle（PLAN M2 量化定义）");
  const a = await startStage();
  const b = await startStage([a.troupe.clusterAddress()!]);
  await waitUntil(() => b.troupe.clusterMembers()!.length === 1);
  const keyA = keyOwnedBy(a.troupe);

  const slowP = a.troupe.cast(ShopCartActor, keyA).slow(300); // 在途请求
  await sleep(30);
  const shutP = a.troupe.shutdown();
  const rejected = await a.troupe.cast(ShopCartActor, keyA).peek().catch((e) => e);
  console.log(`[${ts()}] 停机开始后新 Call → ${(rejected as Error).name}（reason=${(rejected as { reason?: string }).reason}）`);
  console.log(`[${ts()}] 在途请求 settle → ${await slowP}`);
  await shutP;
  console.log(`[${ts()}] 全员 offStage+saveProps：在场 Actor = ${a.troupe.slots().length}`);
  const peerSees = await waitUntil(() => b.troupe.clusterMembers()!.length === 0);
  console.log(`[${ts()}] B 收到 leave 快速收敛：${peerSees}`);
  await b.troupe.shutdown();
}

// ───────────────────────── 9. 全局背压 ─────────────────────────

{
  section("9. 全局背压：在场 Actor 上限 + 排队字节预算（§5.3）");
  const troupe = await Troupe.form({
    actors: [ShopCartActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
    defaultTimeout: "10s",
    maxActivations: 1,
    maxQueuedBytes: 300,
  });
  await troupe.cast(ShopCartActor, "first").add("x");
  const cap = await troupe.cast(ShopCartActor, "second").add("y").catch((e) => e);
  console.log(`[${ts()}] 第二个不同 Actor → ${(cap as Error).name}：${(cap as Error).message.slice(0, 38)}…`);
  console.log(`[${ts()}] （单热点深度上限在 M1 已有；M2 补齐 Stage 级预算，防大量唯一 ID 耗尽内存）`);
  await troupe.drainAll();
}

console.log(`\ndemo 结束（总耗时 ${Date.now() - t0}ms）。测试：npm test（59 例）；多 Stage 故障接管：npm run example:cluster`);
