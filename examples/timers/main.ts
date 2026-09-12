/**
 * Troupe.js 定时器 / 延时任务用法演示（M4 用法指南配套）：
 *
 *   模式 1  内存 Cue registerCue        —— 在场才有效的周期任务（攒批 flush / 心跳）
 *   模式 2  持久周期提醒 scheduleReminder —— 跨下场/跨重启的业务巡检（至少一次 + 幂等）
 *   模式 3  一次性延时任务（at）          —— "N 毫秒后若 X 未发生则 Y"（订单超时取消）
 *   模式 4  幂等重试延时（at + idempotent）—— 外部调用失败后延迟重试，不重不漏
 *   反例    在 Turn 里 sleep              —— 占用串行通道，阻塞后续调用（打印演示）
 *
 * 运行：npm run example:timers
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actor, Cron, Every, Local, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";
import { SqliteCueStore } from "../../src/cues/sqlite.js";

const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(4, " ")}ms`;
const section = (t: string) => console.log(`\n━━━ ${t} ━━━`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───── 模式 1：内存 Cue 攒批 flush（DESIGN §10.3 Inventory 风格）─────

let flushCount = 0;

interface FlushCartProps {
  items: string[];
  dirty: boolean;
}

class FlushCartActor extends Actor<FlushCartProps> {
  static role = "FlushCart";
  static initialProps = (): FlushCartProps => ({ items: [], dirty: false });

  override async onStage() {
    // 在场期间每 300ms 攒批落盘一次；随下场自动清理，重新登台时重新注册
    this.registerCue("flush", 300, async () => {
      if (!this.props.dirty) return;
      await this.saveProps();
      this.props.dirty = false;
      flushCount++;
      console.log(`  [${ts()}] flush：内存 → 磁盘（items=${this.props.items.length}）`);
    });
  }

  async add(item: string) {
    this.props.items.push(item); // 业务热路径：纯内存，零 IO
    this.props.dirty = true;
    return this.props.items.length;
  }

  async peek() {
    return this.props.items.length;
  }
}

// ───── 模式 2：持久周期提醒（跨下场/重启的巡检）─────

let patrolCount = 0;

class PatrolActor extends Actor<{ lastPatrolAt: number | null }> {
  static role = "Patrol";
  static initialProps = () => ({ lastPatrolAt: null });

  async start() {
    // 持久提醒：写入 CueStore；Actor 下场/进程重启都不影响触发（触发即重新登台）
    await this.scheduleReminder("patrol", { every: 500, payload: { kind: "巡检" } });
    return true;
  }

  override async onCue(name: string, payload: unknown) {
    // 至少一次投递：业务按 (name, payload) 幂等
    patrolCount++;
    this.props.lastPatrolAt = Date.now();
    await this.saveProps();
    console.log(`  [${ts()}] 持久提醒 "${name}" 触发（第 ${patrolCount} 次，payload=${JSON.stringify(payload)}）`);
  }

  async status() {
    return { patrolCount, lastPatrolAt: this.props.lastPatrolAt };
  }
}

// ───── 模式 3：一次性延时任务（订单超时取消）─────

interface OrderProps {
  status: "pending" | "paid" | "cancelled";
  amount: number;
}

class OrderActor extends Actor<OrderProps> {
  static role = "Order";
  static initialProps = (): OrderProps => ({ status: "pending", amount: 0 });

  async create(amount: number) {
    this.props.amount = amount;
    await this.saveProps();
    // 延时任务：800ms 后未支付则取消（at 一次性；跨下场/重启依然生效）
    await this.scheduleReminder("payment-timeout", {
      at: Date.now() + 800,
      payload: { orderId: this.stageName },
    });
    return `订单 ${this.stageName} 创建（¥${amount}，800ms 支付窗口）`;
  }

  async pay() {
    if (this.props.status !== "pending") return `拒绝：订单已是 ${this.props.status}`;
    this.props.status = "paid";
    await this.saveProps();
    await this.cancelReminder("payment-timeout"); // 支付成功 → 注销延时任务（注销竞争由 CAS 裁决）
    return `订单 ${this.stageName} 已支付`;
  }

  override async onCue(name: string, _payload: unknown) {
    if (name !== "payment-timeout") return;
    if (this.props.status === "pending") {
      this.props.status = "cancelled";
      await this.saveProps();
      console.log(`  [${ts()}] ⏰ 订单 ${this.stageName} 超时未支付 → 已取消`);
    }
    // 已支付：任务被 cancel 注销，即便重复投递也无副作用（幂等）
  }

  async status() {
    return this.props.status;
  }
}

// ───── 模式 4：幂等重试延时（外部调用失败 → 延迟重试）─────

let externalAttempts = 0;

class DeliveryActor extends Actor<{ delivered: boolean; requestId: string | null }> {
  static role = "Delivery";
  static initialProps = () => ({ delivered: false, requestId: null });

  /** 幂等的是"受理"：同 requestId 重复提交直接重放，不重新投递 */
  async submit(requestId: string) {
    return this.idempotent(`accept:${requestId}`, requestId, async () => {
      this.props.requestId = requestId;
      await this.saveProps();
      await this.attempt();
      return { ok: true, note: "已受理" };
    });
  }

  /** 重试是提醒驱动的内部状态机：失败 → 登记 400ms 后重试；成功 → 落盘 */
  private async attempt() {
    externalAttempts++;
    if (externalAttempts < 3) {
      await this.scheduleReminder("retry", { at: Date.now() + 400 });
      console.log(`  [${ts()}] 外部投递第 ${externalAttempts} 次失败 → 已登记 400ms 后重试`);
      return;
    }
    this.props.delivered = true;
    await this.saveProps();
    console.log(`  [${ts()}] ✅ 第 ${externalAttempts} 次投递成功`);
  }

  override async onCue(name: string) {
    if (name === "retry" && !this.props.delivered) await this.attempt();
  }

  async status() {
    return this.props.delivered;
  }
}

// ───── 模式 5：声明式装饰器（@Cron/@Every/@Local，推荐）─────

let sweepRuns = 0;
let hbRuns = 0;

class DeclarativeActor extends Actor<{ swept: number }> {
  static role = "Declarative";
  static initialProps = () => ({ swept: 0 });

  @Every(200) // 持久周期：激活即自动登记，跨下场/重启
  async sweep() {
    sweepRuns++;
    this.props.swept++;
    await this.saveProps();
  }

  @Cron("30 3 * * *") // cron：每天 03:30（本地时间）；演示只验证登记的 nextDue
  async nightly() {}

  @Local(80) // 内存 Cue：仅在场时有效
  async heartbeat() {
    hbRuns++;
  }

  async trigger() {
    return "ok";
  }
}

// ───── 反例：在 Turn 里 sleep 会占住串行通道 ─────

class BlockingActor extends Actor<Record<string, never>> {
  static role = "Block";
  static initialProps = () => ({}) as Record<string, never>;

  async slow(n: number) {
    await sleep(n); // ⚠ 业务方法内长 sleep：整个 Actor 的串行通道被占住
    return "slow-done";
  }

  async quick() {
    return "quick-done";
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "troupe-timers-"));
  const troupe = await Troupe.form({
    actors: [FlushCartActor, PatrolActor, OrderActor, DeliveryActor, BlockingActor, DeclarativeActor],
    propStore: new SqlitePropStore(join(dir, "props")),
    cues: { store: new SqliteCueStore(join(dir, "cues")), tickMs: 100 },
    defaultIntermission: 400, // 短 intermission：便于观察"下场后持久提醒仍触发"
    defaultTimeout: "10s",
  });

  section("模式 1：内存 Cue 攒批 flush（在场有效，业务热路径零 IO）");
  const cart = troupe.cast(FlushCartActor, "cart-1");
  console.log(`  [${ts()}] add ×5（纯内存）：${await cart.add("a")}…`);
  for (let i = 0; i < 4; i++) await cart.add(`item-${i}`);
  await sleep(1_000); // 期间 flush Cue 每 300ms 落盘
  console.log(`  [${ts()}] flush 共执行 ${flushCount} 次；适合库存/购物车类攒批写入`);

  section("模式 2：持久周期提醒（Actor 下场后仍按时触发并重新登台）");
  const patrol = troupe.cast(PatrolActor, "patrol-1");
  await patrol.start();
  await sleep(1_300); // intermission 400ms → Actor 已下场过至少一次，提醒仍持续触发
  console.log(`  [${ts()}] 巡检 ${patrolCount} 次；上次：${JSON.stringify((await patrol.status()).lastPatrolAt)}（重启进程也会从 CueStore 恢复）`);

  section("模式 3：一次性延时任务（订单 800ms 支付窗口）");
  const o1 = troupe.cast(OrderActor, "order-1");
  const o2 = troupe.cast(OrderActor, "order-2");
  console.log(`  [${ts()}] ${await o1.create(99)}`);
  console.log(`  [${ts()}] ${await o2.create(199)}`);
  await sleep(150);
  console.log(`  [${ts()}] ${await o2.pay()}（窗口内支付 → 注销延时任务）`);
  await sleep(1_200);
  console.log(`  [${ts()}] order-1 = ${await o1.status()}（超时取消）；order-2 = ${await o2.status()}`);

  section("模式 4：幂等受理 + 延迟重试（失败 → 400ms 后重试，不重不漏）");
  const delivery = troupe.cast(DeliveryActor, "delivery-1");
  await delivery.submit("req-1"); // 受理 + 首次投递失败 → 登记重试
  await delivery.submit("req-1"); // 调用方重试提交：幂等重放"已受理"，不触发新投递
  await sleep(1_600); // 重试提醒 → 第 2 次失败再登记 → 第 3 次成功
  console.log(`  [${ts()}] 最终 delivered = ${await delivery.status()}（外部尝试 ${externalAttempts} 次；受理幂等、重试由提醒驱动）`);

  section("模式 5：声明式装饰器 @Cron/@Every/@Local（无需手写 onStage 注册）");
  const decl = troupe.cast(DeclarativeActor, "decl-1");
  await decl.trigger(); // 激活 → @Every/@Cron 自动登记（不存在才插入）、@Local 自动注册
  await sleep(700);
  const declCues = (await troupe.director().cues()) as Array<{ roleId: string; name: string; nextDue: string }>;
  const nightly = declCues.find((c) => c.roleId === "Declarative" && c.name === "nightly");
  console.log(`  [${ts()}] @Every(200ms) 已触发 ${sweepRuns} 次；@Local(80ms) 心跳 ${hbRuns} 次`);
  console.log(`  [${ts()}] @Cron("30 3 * * *") 已登记，nextDue=${nightly ? new Date(nightly.nextDue).toLocaleString("zh-CN") : "?"}`);
  console.log(`  [${ts()}] 装饰的方法仍可 RPC 手动触发（CLI：troupe call Declarative decl-1 sweep）`);

  section("反例：在 Turn 里 sleep 会占住串行通道（§5.1 执行占用）");
  const block = troupe.cast(BlockingActor, "block-1");
  const slowP = block.slow(400);
  await sleep(50);
  const quickStart = Date.now();
  await block.quick(); // 必须等 slow 真正结束
  console.log(`  [${ts()}] quick 排队等待了 ${Date.now() - quickStart}ms（应为 ~350ms）`);
  console.log(`  [${ts()}] 结论：延时等待不要 sleep 在业务方法里——用 scheduleReminder(at) 登记延时任务`);
  await slowP;

  await troupe.shutdown();
  console.log(`\ndemo 结束（数据目录 ${dir} 可删）。选择速查：内存 Cue=在场周期，持久 every=跨重启巡检，at=延时任务，at+idempotent=失败重试`);
}

void main();
