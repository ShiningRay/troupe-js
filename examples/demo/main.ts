/**
 * Troupe.js M1 Demo —— 一段脚本跑完 M1 的核心行为：
 *   1. 组团 / cast / 激活 single-flight
 *   2. 严格串行（Turn 一次一条）
 *   3. 超时与执行占用（调用方超时 ≠ 放行下一 Turn）
 *   4. Intermission 空闲回收 + 重新登台
 *   5. 跨 Actor 协作：下单流程（Order → Inventory + Account，含补偿与幂等重放）
 *   6. fan-out：多个 Actor 并行 vs 单个热点 Actor 串行
 *   7. 幂等执行（同键同参重放 / 同键异参拒绝）
 *   8. 保存失败 → 实例失效 → 从最后已提交快照恢复
 *
 * 运行：npm run demo
 */
import { Actor, CallTimeoutError, Intermission, Performs, Troupe } from "../../src/index.js";
import { InMemoryPropStore } from "../../src/props/memory.js";

const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(4, " ")}ms`;
const section = (title: string) => console.log(`\n━━━ ${title} ━━━`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 1. 基本调用 + single-flight ─────────────────────────

interface CartProps {
  items: string[];
}

let cartOnStage = 0;

@Performs()
@Intermission("10m")
class CartActor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] });

  override async onStage() {
    cartOnStage++;
  }

  override async offStage() {
    await this.saveProps();
  }

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps(); // 持久成功：提交成功后才返回
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

{
  section("1. 组团与激活 single-flight");
  const troupe = await Troupe.form({ actors: [CartActor], defaultIntermission: 0 });
  const cart = troupe.cast(CartActor, "user-123");

  const counts = await Promise.all([
    cart.add("apple"),
    cart.add("bread"),
    cart.add("cider"),
    cart.add("donut"),
    cart.add("eggs"),
  ]);
  console.log(`[${ts()}] 5 个并发 add 完成，最终数量 = ${counts[4]}，onStage 执行次数 = ${cartOnStage}`);
  await troupe.drainAll();
}

// ───────────────────────── 2. 严格串行 ─────────────────────────

const timeline: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

class TellerActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async serve(id: string) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    timeline.push(`#${id} 开始`);
    await sleep(30);
    timeline.push(`#${id} 结束`);
    inFlight--;
    return id;
  }
}

{
  section("2. 严格串行：一次只处理一条 Call（无锁）");
  const troupe = await Troupe.form({ actors: [TellerActor], propStore: new InMemoryPropStore(), defaultIntermission: 0 });
  const teller = troupe.cast(TellerActor, "teller-1");

  await Promise.all([teller.serve("1"), teller.serve("2"), teller.serve("3")]);
  console.log(`[${ts()}] 执行顺序：${timeline.join(" → ")}`);
  console.log(`[${ts()}] 最大并发 Turn 数 = ${maxInFlight}（应为 1）`);
  await troupe.drainAll();
}

// ───────────────────────── 3. 超时与执行占用 ─────────────────────────

const benchLog: string[] = [];

class BenchActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;
  static timeouts = { slow: 80 }; // 只有 slow 方法 80ms 超时

  async slow(id: string, ms: number) {
    benchLog.push(`slow#${id} 开始`);
    await sleep(ms);
    benchLog.push(`slow#${id} 真正结束`);
    return `${id}-done`;
  }

  async quick(id: string) {
    benchLog.push(`quick#${id} 开始`);
    return `${id}-done`;
  }
}

{
  section("3. 超时与执行占用分离（DESIGN §5.1）");
  const troupe = await Troupe.form({ actors: [BenchActor], propStore: new InMemoryPropStore(), defaultTimeout: "10s", defaultIntermission: 0 });
  const bench = troupe.cast(BenchActor, "bench-1");

  const slowP = bench.slow("A", 200); // A 要跑 200ms，但 80ms 就超时
  await sleep(10);
  const quickP = bench.quick("B"); // B 排队

  const err = (await slowP.catch((e) => e)) as CallTimeoutError;
  console.log(`[${ts()}] A 的调用方在 80ms 收到超时：phase=${err.phase}（结果未知，非失败）`);

  const bResult = await quickP; // B 必须等 A 真正 settle 后才开始
  console.log(`[${ts()}] B 返回 ${bResult}——执行顺序：${benchLog.join(" → ")}`);
  console.log(`[${ts()}] 结论：调用方超时没有放行 B，B 未与 A 交错`);
  await troupe.drainAll();
}

// ───────────────────────── 4. Intermission 空闲回收 ─────────────────────────

let gcOnStage = 0;
let gcOffStage = 0;

class SessionActor extends Actor<{ n: number }> {
  static initialProps = () => ({ n: 0 });

  override async onStage() {
    gcOnStage++;
  }

  override async offStage() {
    gcOffStage++;
    await this.saveProps();
  }

  async bump() {
    this.props.n++;
    await this.saveProps();
    return this.props.n;
  }
}

{
  section("4. Intermission 空闲回收（本 demo 设 600ms）");
  const troupe = await Troupe.form({ actors: [SessionActor], propStore: new InMemoryPropStore(), defaultIntermission: 600 });
  const session = troupe.cast(SessionActor, "session-1");

  await session.bump();
  console.log(`[${ts()}] 调用后在场 Actor 数 = ${troupe.slots().length}，等待 900ms…`);
  await sleep(900);
  console.log(`[${ts()}] 空闲到期：在场 = ${troupe.slots().length}，offStage 触发 ${gcOffStage} 次（Props 已归还）`);

  const n = await session.bump(); // 重新登台，从已保存快照恢复
  console.log(`[${ts()}] 再次调用 → 重新登台（onStage=${gcOnStage}），n 从快照恢复 = ${n}`);
  await troupe.drainAll();
}

// ───────────────────────── 5. 跨 Actor 协作：下单流程 ─────────────────────────
//
// OrderActor（每订单一个实例）编排两个领域 Actor：
//   InventoryActor（每 SKU）：reserve / release（各自幂等）
//   AccountActor（每用户）：deposit / charge（各自幂等）
// 跨 Actor 没有事务：扣款失败时用"释放库存"做业务补偿（DESIGN §6.5）。

interface ShopInventoryProps {
  remaining: number;
  reservedBy: Record<string, number>;
}

class ShopInventoryActor extends Actor<ShopInventoryProps> {
  static initialProps = (): ShopInventoryProps => ({ remaining: 3, reservedBy: {} });

  async reserve(requestId: string, qty: number) {
    return this.idempotent(`reserve:${requestId}`, `${requestId}:${qty}`, async () => {
      if (this.props.remaining < qty) return { ok: false, remaining: this.props.remaining };
      this.props.remaining -= qty;
      this.props.reservedBy[requestId] = qty;
      return { ok: true, remaining: this.props.remaining };
    });
  }

  async release(requestId: string, qty: number) {
    return this.idempotent(`release:${requestId}`, `${requestId}:${qty}`, async () => {
      this.props.remaining += qty;
      delete this.props.reservedBy[requestId];
      return { ok: true, remaining: this.props.remaining };
    });
  }

  async remaining() {
    return this.props.remaining;
  }
}

class ShopAccountActor extends Actor<{ balance: number }> {
  static initialProps = () => ({ balance: 0 });

  async deposit(requestId: string, amount: number) {
    return this.idempotent(`deposit:${requestId}`, `${requestId}:${amount}`, async () => {
      this.props.balance += amount;
      return { ok: true, balance: this.props.balance };
    });
  }

  async charge(requestId: string, amount: number) {
    return this.idempotent(`charge:${requestId}`, `${requestId}:${amount}`, async () => {
      if (this.props.balance < amount) return { ok: false, balance: this.props.balance };
      this.props.balance -= amount;
      return { ok: true, balance: this.props.balance };
    });
  }

  async balance() {
    return this.props.balance;
  }
}

class ShopOrderActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async place(userId: string, sku: string, qty: number, amount: number) {
    const orderId = this.stageName;
    const inv = this.cast(ShopInventoryActor, sku); // Actor 互调（DESIGN §10.1）
    const acct = this.cast(ShopAccountActor, userId);

    const r = await inv.reserve(orderId, qty);
    if (!r.ok) return { status: "rejected", reason: "库存不足", remaining: r.remaining };

    const c = await acct.charge(orderId, amount);
    if (!c.ok) {
      // 业务补偿：跨 Actor 无事务，失败路径显式回滚库存（DESIGN §6.5）
      const rel = await inv.release(orderId, qty);
      return { status: "rejected", reason: "余额不足（已补偿释放库存）", remaining: rel.remaining, balance: c.balance };
    }
    return { status: "confirmed", remaining: r.remaining, balance: c.balance };
  }
}

{
  section("5. 跨 Actor 协作：下单（Order → Inventory + Account，含补偿）");
  const troupe = await Troupe.form(
    { actors: [ShopOrderActor, ShopInventoryActor, ShopAccountActor], propStore: new InMemoryPropStore(), defaultIntermission: 0 },
  );

  // 种子数据：alice 充 100，bob 充 10；sku-1 库存 3（initialProps）
  await troupe.cast(ShopAccountActor, "alice").deposit("seed-alice", 100);
  await troupe.cast(ShopAccountActor, "bob").deposit("seed-bob", 10);
  console.log(`[${ts()}] 初始：sku-1 库存 = ${await troupe.cast(ShopInventoryActor, "sku-1").remaining()}，alice = ¥100，bob = ¥10`);

  const r1 = await troupe.cast(ShopOrderActor, "order-1").place("alice", "sku-1", 2, 40);
  console.log(`[${ts()}] order-1（alice ×2 ¥40）→ ${JSON.stringify(r1)}`);

  const r2 = await troupe.cast(ShopOrderActor, "order-2").place("bob", "sku-1", 1, 40);
  console.log(`[${ts()}] order-2（bob   ×1 ¥40）→ ${JSON.stringify(r2)}`);

  const replay = await troupe.cast(ShopOrderActor, "order-1").place("alice", "sku-1", 2, 40);
  console.log(`[${ts()}] 重放 order-1（网络重试）→ ${JSON.stringify(replay)}`);
  console.log(
    `[${ts()}] 事后核对：库存 = ${await troupe.cast(ShopInventoryActor, "sku-1").remaining()}，` +
      `alice = ¥${await troupe.cast(ShopAccountActor, "alice").balance()}，` +
      `bob = ¥${await troupe.cast(ShopAccountActor, "bob").balance()}`,
  );
  await troupe.drainAll();
}

// ───────────────────────── 6. fan-out：并行 vs 热点串行 ─────────────────────────

class FanWorkerActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async crunch(n: number) {
    await sleep(30);
    return n * 2;
  }
}

class FanCoordinatorActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  /** fan-out 到 n 个不同 worker（不同 stageName = 不同 Actor 实例，可并行） */
  async fanOut(n: number) {
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => this.cast(FanWorkerActor, `worker-${i}`).crunch(i)),
    );
    return results.reduce((a, b) => a + b, 0);
  }

  /** 同一个热点 worker 上的 n 次调用：只能串行（单通道容量事实，DESIGN §5.3） */
  async serialHot(n: number) {
    const worker = this.cast(FanWorkerActor, "worker-hot");
    const results: number[] = [];
    for (let i = 0; i < n; i++) results.push(await worker.crunch(i));
    return results.reduce((a, b) => a + b, 0);
  }
}

{
  section("6. fan-out：5 个 Actor 并行 vs 同一热点 Actor 串行");
  const troupe = await Troupe.form(
    { actors: [FanCoordinatorActor, FanWorkerActor], propStore: new InMemoryPropStore(), defaultIntermission: 0 },
  );
  const coord = troupe.cast(FanCoordinatorActor, "coord-1");

  const t1 = Date.now();
  const sumP = await coord.fanOut(5);
  const parallelMs = Date.now() - t1;

  const t2 = Date.now();
  const sumS = await coord.serialHot(5);
  const serialMs = Date.now() - t2;

  console.log(`[${ts()}] 5 个不同 worker 并行：sum=${sumP}，耗时 ${parallelMs}ms（≈ 单个任务 30ms）`);
  console.log(`[${ts()}] 同一热点 worker 串行：sum=${sumS}，耗时 ${serialMs}ms（≈ 5 × 30ms）`);
  console.log(`[${ts()}] 容量事实（§5.3）：单个热点 Actor 只有一个串行通道，扩容靠更多 Actor/Stage`);
  await troupe.drainAll();
}

// ───────────────────────── 7. 幂等执行 ─────────────────────────

let reserveExecutions = 0;

class InventoryActor extends Actor<{ remaining: number }> {
  static initialProps = () => ({ remaining: 5 });

  async reserve(requestId: string, qty: number) {
    // 键=操作键，指纹=参数；helper 在完成后原子提交 状态+幂等记录
    return this.idempotent(`reserve:${requestId}`, `${requestId}:${qty}`, async () => {
      reserveExecutions++;
      this.props.remaining -= qty;
      return { ok: true, remaining: this.props.remaining };
    });
  }
}

{
  section("7. 幂等执行（DESIGN §6.5 失败契约）");
  const troupe = await Troupe.form({ actors: [InventoryActor], propStore: new InMemoryPropStore(), defaultIntermission: 0 });
  const inv = troupe.cast(InventoryActor, "sku-9527");

  const first = await inv.reserve("order-1", 2);
  const replay = await inv.reserve("order-1", 2); // 网络重试场景：同键同参
  console.log(`[${ts()}] 首次 = ${JSON.stringify(first)}，重放 = ${JSON.stringify(replay)}，实际执行次数 = ${reserveExecutions}`);

  const conflict = await inv.reserve("order-1", 3).catch((e) => e); // 同键不同参数
  console.log(`[${ts()}] 同键不同参数 → ${conflict.constructor.name}：${(conflict as Error).message}`);
  await troupe.drainAll();
}

// ───────────────────────── 8. 保存失败 → 失效 → 恢复 ─────────────────────────

class FlakyStore extends InMemoryPropStore {
  failNext = false;

  override async write(...args: Parameters<InMemoryPropStore["write"]>) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("模拟磁盘故障");
    }
    return super.write(...args);
  }
}

{
  section("8. 保存失败：实例失效，从最后已提交快照恢复（DESIGN §7.3）");
  const store = new FlakyStore();
  const troupe = await Troupe.form({ actors: [CartActor], propStore: store, defaultIntermission: 0 });
  const cart = troupe.cast(CartActor, "user-9");

  await cart.add("committed-1");
  store.failNext = true;
  const err = await cart.add("lost-2").catch((e) => e); // 这次保存失败
  console.log(`[${ts()}] 第二次 add 保存失败 → 调用方收到：${(err as Error).message}`);

  const count = await cart.peek(); // 重新激活，加载最后已提交快照
  console.log(`[${ts()}] 重新登台后 peek = ${count}（"lost-2" 未污染后续状态）`);
  await cart.add("committed-3");
  console.log(`[${ts()}] 继续可用：peek = ${await cart.peek()}`);
  await troupe.drainAll();
}

console.log("\ndemo 结束。多 Stage/故障接管演示：npm run example:cluster；测试：npm test（59 例）");
