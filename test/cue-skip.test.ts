/** 内存 Cue 跳拍可观测：上一拍未完成时跳拍计入 metrics.cueSkipped 并发 cueSkipped 埋点 */
import { afterEach, describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";

class SlowTickActor extends Actor<{ beats: number }> {
  static initialProps = () => ({ beats: 0 });

  override async onStage() {
    // 故意慢于周期（150ms > 50ms）：验证跳拍被计数，而不是静默堆积/变慢
    this.registerCue("beat", "50ms", async () => {
      await new Promise((r) => setTimeout(r, 150));
      this.props.beats++;
    });
  }

  async getBeats(): Promise<number> {
    return this.props.beats;
  }
}

let troupe: Troupe | undefined;
afterEach(async () => {
  if (troupe) {
    await troupe.drainAll();
    await troupe.shutdown();
    troupe = undefined;
  }
});

describe("内存 Cue 跳拍可观测", () => {
  it("跳拍计入 metrics 并发 cueSkipped 事件（带 cue 名）", async () => {
    troupe = await Troupe.form({ actors: [SlowTickActor] });
    const skipped: unknown[] = [];
    troupe.events.on((e) => {
      if (e.type === "cueSkipped") skipped.push(e);
    });

    const a = troupe.cast(SlowTickActor, "s1");
    await a.getBeats(); // 激活 → onStage 注册 cue
    await new Promise((r) => setTimeout(r, 600));

    const snap = troupe.metrics.snapshot()["SlowTick"];
    expect(snap?.cueSkipped).toBeGreaterThanOrEqual(1);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0]).toMatchObject({ roleId: "SlowTick", method: "beat" });
    // 跳拍保护确实生效：拍数远小于理论拍数（12），说明没有堆积并发执行
    expect(await a.getBeats()).toBeLessThan(8);
  });
});
