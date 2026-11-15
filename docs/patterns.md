# 模式与配方

## 库存/秒杀（单 Actor 串行 + 持久成功）

```typescript
class InventoryActor extends Actor<InventoryProps> {
  static initialProps = () => ({ remaining: 0, reservedBy: {} as Record<string, number> });

  async reserve(requestId: string, qty: number) {
    return this.idempotent(`reserve:${requestId}`, `${requestId}:${qty}`, async () => {
      if (this.props.remaining < qty) return { ok: false, remaining: this.props.remaining };
      this.props.remaining -= qty;
      this.props.reservedBy[requestId] = qty;
      return { ok: true, remaining: this.props.remaining };
    });
  }
  // 注意：fn 内不 saveProps——idempotent 在 settle 后原子提交 状态+幂等记录
}
```

热点容量事实：单 Actor 一个串行通道（本机 ~186k msg/s）；扩容 = 更多 Actor（不同 stageName）/更多 Stage。

## 订单超时取消（延时任务）

```typescript
async create(amount: number) {
  this.props.status = "pending";
  await this.saveProps();
  await this.scheduleReminder("payment-timeout", { at: Date.now() + 30 * 60_000 });
}
async pay() {
  this.props.status = "paid";
  await this.saveProps();
  await this.cancelReminder("payment-timeout");   // 注销竞争由 CAS 裁决
}
override async onCue(name: string) {
  if (name === "payment-timeout" && this.props.status === "pending") {
    this.props.status = "cancelled";
    await this.saveProps();
  }
}
```

## 失败重试（幂等受理 + at 提醒驱动状态机）

⚠️ 不要把"暂不可用"作为 `idempotent` 的结果记录——重放会短路重试。正确组合：

```typescript
async submit(requestId: string) {
  return this.idempotent(`accept:${requestId}`, requestId, async () => {
    this.props.requestId = requestId; await this.saveProps();
    await this.attempt();                       // 幂等的是"受理"
    return { ok: true };
  });
}
private async attempt() {                        // 重试是内部状态机
  try { await callExternal(); this.props.delivered = true; await this.saveProps(); }
  catch { await this.scheduleReminder("retry", { at: Date.now() + 400 }); }
}
override async onCue(name: string) {
  if (name === "retry" && !this.props.delivered) await this.attempt();
}
```

## 跨 Actor 编排（无事务，显式补偿）

```typescript
async place(orderId: string, sku: string, qty: number, amount: number) {
  const inv = this.cast(InventoryActor, sku);
  const acct = this.cast(AccountActor, userId);
  const r = await inv.reserve(orderId, qty);
  if (!r.ok) return { status: "rejected", reason: "库存不足" };
  const c = await acct.charge(orderId, amount);
  if (!c.ok) {
    await inv.release(orderId, qty);            // 业务补偿（无跨 Actor 事务）
    return { status: "rejected", reason: "余额不足（已补偿）" };
  }
  return { status: "confirmed" };
}
```

## 攒批写入（内存 Cue）

```typescript
override async onStage() {
  this.registerCue("flush", "2s", async () => {
    if (!this.props.dirty) return;
    await this.saveProps();
    this.props.dirty = false;
  });
}
async add(x: string) { this.props.items.push(x); this.props.dirty = true; } // 热路径零 IO
```

攒批必须明示丢失窗口（RPO = flush 间隔）；要"响应即已落盘"就在调用里 `saveProps`（持久成功）。

## 聊天室（Show 广播）

```typescript
// 房间 Actor
async send(msgId: string, user: string, text: string) {
  return this.idempotent(`send:${msgId}`, `${user}:${text}`, async () => { /* ... */ });
}
// 订阅者（Audience）
override async onStage() { await this.subscribe("chat:lobby"); }
override async onEvent(evt: unknown) { /* Show 非持久投递：重试 3 次后放弃、可能重复——按业务幂等；持久流见 ROADMAP P2 */ }
// 发布
await troupe.publish(`chat:${room}`, message);
```

**边缘推送（进程内 callback 订阅者）**：非 Actor 的 HTTP/WS 服务器想转发事件给浏览器，
直接传函数订阅——省掉轮询或"BridgeActor 写模块级单例"的绕路：

```typescript
// tick/业务里发布：await this.publishShow(`room:${this.stageName}`, snapshot);
const un = await troupe.subscribe(`room:${roomId}`, (snapshot) => {
  for (const ws of roomSockets(roomId)) ws.send(JSON.stringify(snapshot)); // 保持快速
});
// 房间无人时 await un() 退订
```

完整示例：`examples/chat`（SSE 前端）、`examples/demo`、`npm run demo:m2`。

## 状态机 + schemaVersion 迁移

```typescript
class CartV2 extends Actor<CartV2Props> {
  static schemaVersion = 2;
  static initialProps = () => ({ items: [] });
  override async migrateProps(stored: unknown, from: number) {
    if (from === 1) { const o = stored as { names?: string[] }; return { items: o.names ?? [] }; }
    return stored as CartV2Props;
  }
}
```

规则：只允许逐级 +1；迁移失败 = 激活失败（不得以半迁移状态服务）。跨 Stage 混跑遵循 [COMPATIBILITY.md](../COMPATIBILITY.md)（R1 方法只增不减 / R3 迁移规则 / R6 幂等指纹稳定）。
