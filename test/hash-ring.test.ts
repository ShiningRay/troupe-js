import { describe, expect, it } from "vitest";
import { HashRing, xxh32 } from "../src/cluster/hash-ring.js";

describe("M2 验收：xxh32 纯 JS 实现与标准向量一致", () => {
  it("已知输入哈希值", () => {
    expect(xxh32("")).toBe(0x02cc5d05);
    expect(xxh32("a")).toBe(0x550d7456);
    expect(xxh32("abc")).toBe(0x32d153ff);
    expect(xxh32("Hello World")).toBe(0xb1fd16ee);
  });

  it("确定性：同输入同哈希", () => {
    expect(xxh32("troupe.js")).toBe(xxh32("troupe.js"));
  });
});

describe("M2 验收：HashRing（DESIGN §6.3）", () => {
  it("空环返回 null；成员稳定后归属确定", () => {
    const empty = new HashRing([]);
    expect(empty.get("any-key")).toBeNull();

    const r1 = new HashRing(["a:1", "b:2", "c:3"]);
    const r2 = new HashRing(["c:3", "a:1", "b:2"]);
    for (let i = 0; i < 100; i++) {
      expect(r1.get(`key-${i}`)).toBe(r2.get(`key-${i}`)); // 构造顺序不影响
    }
  });

  it("摘除节点只迁移该节点的键（一致性）", () => {
    const before = new HashRing(["A", "B", "C"]);
    const keys = Array.from({ length: 500 }, (_, i) => `key-${i}`);
    const ownersBefore = new Map(keys.map((k) => [k, before.get(k)!]));

    const after = new HashRing(["A", "C"]); // B 摘除
    for (const k of keys) {
      const before2 = ownersBefore.get(k)!;
      const after2 = after.get(k)!;
      if (before2 !== "B") {
        expect(after2).toBe(before2); // 非 B 的键不动
      } else {
        expect(["A", "C"]).toContain(after2); // B 的键只迁往 A/C
      }
    }
  });

  it("负载分布合理（10 节点，160 虚拟节点）", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => `stage-${i}`);
    const ring = new HashRing(nodes);
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) {
      const owner = ring.get(`key-${i}`)!;
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    for (const n of nodes) {
      const share = (counts.get(n) ?? 0) / 10_000;
      expect(share).toBeGreaterThan(0.04);
      expect(share).toBeLessThan(0.16);
    }
  });

  it("successors 返回 k 个不同后继且不含自身", () => {
    const ring = new HashRing(["A", "B", "C", "D"]);
    const succ = ring.successors("A", 2);
    expect(succ).toHaveLength(2);
    expect(new Set(succ).size).toBe(2);
    expect(succ).not.toContain("A");
    expect(new HashRing(["A"]).successors("A", 2)).toEqual([]);
  });
});
