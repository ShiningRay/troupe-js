import { Actor, Intermission, Performs, Troupe } from "../../src/index.js";
import { InMemoryPropStore } from "../../src/props/memory.js";

interface Item {
  sku: string;
  qty: number;
}

/** Props 类型与 actor 同文件、不导出（DESIGN §3.1 / §12） */
interface CartProps {
  items: Item[];
}

@Performs() // 角色名默认 = 类名去 "Actor" 后缀 → "Cart"
@Intermission("10m")
export class CartActor extends Actor<CartProps> {
  // 首次登台的初始状态（PropStore 无记录时使用；需要结构的 Props 必须提供工厂）
  static initialProps = (): CartProps => ({ items: [] });

  async onStage() {
    console.log(`[cart:${this.stageName}] 登台`);
  }

  async offStage() {
    await this.saveProps(); // 下场归还 Props（DESIGN §7.3）
    console.log(`[cart:${this.stageName}] 下场（已保存）`);
  }

  async add(item: Item) {
    this.props.items.push(item);
    await this.saveProps(); // 持久成功：提交成功后才返回
  }

  async peek() {
    return this.props.items.length;
  }
}

// ---- 运行 ----

// 显式 InMemory 保持示例可重复运行；非 test 环境缺省为 SqlitePropStore（./.troupe/props.db）
const troupe = await Troupe.form({ actors: [CartActor], propStore: new InMemoryPropStore() });

const cart = troupe.cast(CartActor, "user-123"); // Agent<CartActor>：类型面只有 RPC 方法
await cart.add({ sku: "sku-1", qty: 1 });
await cart.add({ sku: "sku-2", qty: 2 });
console.log(`peek() = ${await cart.peek()}`); // 2

// Agent 表面验证（DESIGN §3.2）：非 RPC 成员不可见、不误当 thenable
const loose = cart as unknown as Record<string, unknown>;
console.log(`agent.props       → ${loose.props}`); // undefined
console.log(`"then" in agent   → ${"then" in cart}`); // false
console.log(`"add" in agent    → ${"add" in cart}`); // true

// 并发首调共享一次激活（single-flight，DESIGN §5.2）
await Promise.all([cart.add({ sku: "sku-3", qty: 3 }), cart.add({ sku: "sku-4", qty: 4 })]);
console.log(`peek() = ${await cart.peek()}`); // 4

await troupe.drainAll(); // 排空：offStage + saveProps
console.log("done");
