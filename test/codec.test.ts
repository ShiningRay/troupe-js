import { describe, expect, it } from "vitest";
import { Actor, SerializationError, Troupe, codecCopy } from "../src/index.js";

class EchoActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async echo(v: unknown) {
    return v;
  }
}

class MutateActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async mutate(o: { n: number }) {
    o.n = 99;
    return o.n;
  }
}

class ResultActor extends Actor<{ list: number[] }> {
  static initialProps = () => ({ list: [1, 2, 3] });

  async getList() {
    return this.props.list;
  }
}

class RefActor extends Actor<Record<string, never>> {
  static initialProps = () => ({}) as Record<string, never>;

  async same(o: object) {
    return o;
  }
}

describe("M2 验收：Codec 边界语义（DESIGN §6.1）", () => {
  it("Date → ISO 字符串；undefined 字段按 JSON 语义丢失", () => {
    const d = new Date("2026-09-12T08:00:00.000Z");
    expect(codecCopy({ at: d, memo: undefined })).toEqual({ at: "2026-09-12T08:00:00.000Z" });
  });

  it("BigInt / Map / Set / 函数 / 循环引用 → SerializationError 并附指引", () => {
    expect(() => codecCopy({ n: 1n })).toThrowError(/BigInt.*string\/number/);
    expect(() => codecCopy({ m: new Map() })).toThrowError(/Map\/Set.*普通对象/);
    expect(() => codecCopy({ s: new Set() })).toThrowError(/Map\/Set.*普通对象/);
    expect(() => codecCopy({ f: () => 1 })).toThrowError(/函数.*DTO/);
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => codecCopy(o)).toThrowError(/循环引用/);
  });

  it("快路径与 JSON round-trip 语义恒等（性能专项，开放问题 7）", () => {
    // 原始值/原始值数组：快路径直通
    expect(codecCopy("x")).toBe("x");
    expect(codecCopy(42)).toBe(42);
    expect(codecCopy(true)).toBe(true);
    expect(codecCopy(null)).toBe(null);
    expect(codecCopy(["a", 1, true, null])).toEqual(["a", 1, true, null]);
    // -0 归一为 +0（JSON 语义）
    expect(Object.is(codecCopy(-0), 0)).toBe(true);
    // NaN/±Infinity 不走快路径：JSON 语义归为 null
    expect(codecCopy(Number.NaN)).toBe(null);
    expect(codecCopy(Number.POSITIVE_INFINITY)).toBe(null);
    expect(codecCopy([1, Number.NaN])).toEqual([1, null]);
    // 对象/嵌套仍走慢路径（行为不变）
    expect(codecCopy({ b: 1, a: 2 })).toEqual({ b: 1, a: 2 });
    expect(() => codecCopy(1n)).toThrowError(SerializationError);
  });

  it("Agent 引用不可跨界（提示传 roleId+stageName）", async () => {
    const troupe = await Troupe.form({ actors: [EchoActor], defaultIntermission: 0 });
    const agent = troupe.cast(EchoActor, "e1");
    const err = await agent.echo(agent).catch((e) => e);
    expect(err).toBeInstanceOf(SerializationError);
    expect((err as Error).message).toMatch(/Agent.*重新 cast/);
    await troupe.drainAll();
  });

  it("本地调用默认经复制边界：参数与结果双向隔离（本地/远程行为一致）", async () => {
    const troupe = await Troupe.form({ actors: [MutateActor, ResultActor], defaultIntermission: 0 });
    const mutate = troupe.cast(MutateActor, "m1");
    const arg = { n: 1 };
    expect(await mutate.mutate(arg)).toBe(99);
    expect(arg.n).toBe(1); // Actor 内的修改不影响调用方对象

    const result = troupe.cast(ResultActor, "r1");
    const list = await result.getList();
    list.push(4);
    expect((await result.getList()).length).toBe(3); // 调用方修改不影响 Actor 状态
    await troupe.drainAll();
  });

  it("localCallByReference: true 显式关闭复制（语义分叉自担）", async () => {
    const troupe = await Troupe.form({
      actors: [RefActor],
      localCallByReference: true,
      defaultIntermission: 0,
    });
    const agent = troupe.cast(RefActor, "ref-1");
    const o = { marker: true };
    expect(await agent.same(o)).toBe(o); // 引用穿透
    await troupe.drainAll();
  });
});
