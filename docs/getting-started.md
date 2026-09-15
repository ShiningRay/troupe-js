# 快速开始

> 要求 Node >= 22.13。仓库内开发：`npm install && npm run build`。

## 最小示例

```typescript
import { Actor, Performs, Intermission, Troupe } from "troupe";

interface CartProps { items: string[] }

@Performs()                    // 角色名 = 类名去 "Actor" 后缀 → "Cart"
@Intermission("10m")           // 空闲 10 分钟自动下场
export class CartActor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] }); // 首次登台的初始状态

  async offStage() { await this.saveProps(); }            // 下场前落盘

  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();   // 持久成功：提交成功后才返回
  }

  async peek() { return this.props.items.length; }
}

const troupe = await Troupe.form({ actors: [CartActor] });
const cart = troupe.cast(CartActor, "user-123"); // Agent<CartActor>：类型安全代理
await cart.add("apple");
console.log(await cart.peek()); // 1
```

要点：

- **无需显式创建 Actor**：`cast(roleId, stageName)` 即全局寻址；首次调用自动激活（登台），从 PropStore 恢复 Props
- **严格串行**：同一 Actor 一次只处理一条调用（Turn），天然无锁；并发 100 个 `add` 不会交错
- **故障即重激活**：进程崩溃后下一次调用会在（同机或其它）Stage 重新登台，从最后已提交快照恢复

## 测试

```typescript
import { Troupe } from "troupe";

const troupe = await Troupe.form({ actors: [CartActor] }); // NODE_ENV=test 自动全内存
const cart = troupe.cast(CartActor, "test-user");
await cart.add("a");
// 清理：排空在场 Actor
await troupe.drainAll();
```

或使用 `troupe/testing` 的 `Rehearsal`（强制 InMemory 的包装）。完整验收样例见仓库 `test/`。

## 持久化

```bash
# 默认：SqlitePropStore（进程级持久，./.troupe/props.db，零配置）
# 多节点生产：共享 Postgres + 所有权
TROUPE_PROPSTORE=postgres://user:pass@host/db troupe ...
```

## 集群（两个进程组团）

```bash
# 进程 A
node app.js
# 进程 B
TROUPE_SEEDS=<A 的地址> node app.js
```

```typescript
const troupe = await Troupe.form({
  actors: [CartActor],
  cluster: { port: 7300 },           // A；B 用 seeds: ["127.0.0.1:7300"]
  ownership: { leaseMs: 5000 },      // 租约 + fencing（多节点生产必开）
});
```

详见 [operations.md](./operations.md)。
