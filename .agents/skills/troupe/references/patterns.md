# 模式与配方（Skill 参考）

## 库存/秒杀

```typescript
async reserve(requestId: string, qty: number) {
  return this.idempotent(`reserve:${requestId}`, `${requestId}:${qty}`, async () => {
    if (this.props.remaining < qty) return { ok: false, remaining: this.props.remaining };
    this.props.remaining -= qty;
    this.props.reservedBy[requestId] = qty;
    return { ok: true, remaining: this.props.remaining };
  }); // helper 原子提交 状态+幂等记录；fn 内不要 saveProps
}
```

热读方法（`available()`）与写方法同 Actor 串行——读零 IO。热点扩容：不同 stageName 并行（单 Actor ~186k msg/s 封顶）。

## 订单超时取消

```typescript
async create(amount: number) {
  this.props.status = "pending"; await this.saveProps();
  await this.scheduleReminder("timeout", { at: Date.now() + 30 * 60_000 });
}
async pay() {
  if (this.props.status !== "pending") return "already";
  this.props.status = "paid"; await this.saveProps();
  await this.cancelReminder("timeout");
}
override async onCue(name: string) {
  if (name === "timeout" && this.props.status === "pending") {
    this.props.status = "cancelled"; await this.saveProps();
  }
}
```

## 幂等受理 + 重试状态机（外部调用不可靠时）

```typescript
async submit(requestId: string) {
  return this.idempotent(`accept:${requestId}`, requestId, async () => {
    this.props.requestId = requestId; await this.saveProps();
    await this.attempt();
    return { ok: true, note: "accepted" };
  });
}
private async attempt() {
  try { await external(); this.props.delivered = true; await this.saveProps(); }
  catch { await this.scheduleReminder("retry", { at: Date.now() + 400 }); }
}
override async onCue(name: string) { if (name === "retry" && !this.props.delivered) await this.attempt(); }
```

关键：受理与重试分离——失败不是 idempotent 的"结果"。

## 跨 Actor 编排（补偿，非事务）

```typescript
async place(orderId: string, sku: string, userId: string, qty: number, amount: number) {
  const r = await this.cast(InventoryActor, sku).reserve(orderId, qty);
  if (!r.ok) return { status: "rejected", reason: "out-of-stock" };
  const c = await this.cast(AccountActor, userId).charge(orderId, amount);
  if (!c.ok) {
    await this.cast(InventoryActor, sku).release(orderId, qty); // 补偿
    return { status: "rejected", reason: "insufficient-balance" };
  }
  return { status: "confirmed" };
}
```

## 攒批写入（热路径零 IO）

```typescript
override async onStage() {
  this.registerCue("flush", "2s", async () => {
    if (!this.props.dirty) return;
    await this.saveProps(); this.props.dirty = false;
  });
}
```

## 状态迁移

```typescript
static schemaVersion = 2;
override async migrateProps(stored: unknown, from: number) {
  if (from === 1) { const o = stored as { names?: string[] }; return { items: o.names ?? [] }; }
  return stored as Props;
}
```

只允许逐级 +1；混跑遵循 COMPATIBILITY.md（方法只增不减、指纹稳定）。

## 测试模板

```typescript
import { Troupe } from "troupe";

it("并发串行", async () => {
  const troupe = await Troupe.form({ actors: [CartActor], defaultIntermission: 0 });
  const cart = troupe.cast(CartActor, "t1");
  await Promise.all(Array.from({ length: 100 }, (_, i) => cart.add(`i${i}`)));
  expect(await cart.peek()).toBe(100);
  await troupe.drainAll(); // 收尾
});

// 错误语义
await expect(cart.callAfterShutdown()).rejects.toMatchObject({ name: "UnknownOutcomeError" });
await expect(cart.callNow()).rejects.toMatchObject({ reason: "backpressure" });
```

## 定时选择速查

| 需求 | 用法 | 生命周期 |
|---|---|---|
| 每 Actor 周期巡检（跨重启） | `@Cron` / `@Every` 或 scheduleReminder(every) | 持久；触发即重登台 |
| 一次性延时（超时取消） | scheduleReminder({ at })；完成 cancelReminder | 持久；CAS 防注销竞争 |
| 在场期间攒批/心跳 | registerCue（onStage 注册） | 下场即清；忙跳拍 |
| 失败重试 | 幂等受理 + at 提醒状态机 | 至少一次 |
