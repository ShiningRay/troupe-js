import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { sleep } from "./helpers.js";

interface CartProps {
  items: string[];
}

let inFlight = 0;
let maxInFlight = 0;

class CartActor extends Actor<CartProps> {
  static initialProps = (): CartProps => ({ items: [] });

  async add(item: string) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(2);
    this.props.items.push(item);
    await this.saveProps();
    inFlight--;
  }

  async peek() {
    return this.props.items.length;
  }
}

describe("M1 验收：严格串行（PLAN M1 / DESIGN §5.1）", () => {
  it("Rehearsal 中 Cart 单测：并发 100 个 add 无交错", async () => {
    inFlight = 0;
    maxInFlight = 0;
    const troupe = await Troupe.form({ actors: [CartActor] });
    const cart = troupe.cast(CartActor, "user-1");

    await Promise.all(Array.from({ length: 100 }, (_, i) => cart.add(`item-${i}`)));

    expect(await cart.peek()).toBe(100);
    expect(maxInFlight).toBe(1); // 任何时刻至多一个 Turn 在执行
    expect(inFlight).toBe(0);
    await troupe.drainAll();
  });

  it("下场后重新登台，Props 从最后已提交快照恢复", async () => {
    const troupe = await Troupe.form({ actors: [CartActor], defaultIntermission: 0 });
    const cart = troupe.cast(CartActor, "user-2");
    await cart.add("a");
    await cart.add("b");
    await troupe.drainAll(); // 手动排空：offStage + saveProps
    expect(troupe.slots().length).toBe(0);
    expect(await cart.peek()).toBe(2); // 重新激活后恢复
  });
});
