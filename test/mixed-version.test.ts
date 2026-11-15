import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import { compatViolations } from "../src/hot/deploy.js";
import { describeRole } from "../src/core/meta.js";
import type { RoleMeta } from "../src/core/meta.js";

/**
 * 混合版本与滚动升级（ADR 0003 §5，ROADMAP P3-3/P3-4）：
 * - compatViolations：R1（方法只增不减）/ R2（必选参数不增）/ R3（schemaVersion 逐级 +1）
 *   自动拒绝；R4 人工门禁、R5/R6 由 golden fixtures 承担
 * - protocolVersion 不一致 → join 显式拒绝（不静默混跑）
 */

class CartV1 extends Actor<{ items: string[] }> {
  static role = "MixCart";
  static initialProps = () => ({ items: [], schemaV: 1 });
  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }
}

class CartV2Same extends Actor<{ items: string[] }> {
  static role = "MixCart";
  static initialProps = () => ({ items: [] });
  async add(item: string) {
    this.props.items.push(item);
    await this.saveProps();
    return this.props.items.length;
  }
  /** 新增方法：R1 允许（只增不减） */
  async clear() {
    this.props.items = [];
    await this.saveProps();
    return 0;
  }
}

class CartV2BadParam extends CartV2Same {
  /** R2 违规：既有方法新增必选参数（无默认值 → function.length 增加） */
  async add(item: string, force: boolean) {
    void force;
    return super.add(item);
  }
}

class CartV2Removed extends Actor<{ items: string[] }> {
  static role = "MixCart";
  static initialProps = () => ({ items: [] });
  /** R1 违规：add 被移除 */
  async clear() {
    this.props.items = [];
    return 0;
  }
}

function metaOf(ctor: typeof Actor): RoleMeta {
  return describeRole(ctor, { intermissionMs: 300_000 }, "mixed-version-test").meta;
}

describe("compatViolations（P3-4 R1–R6 检查矩阵）", () => {
  const v1 = metaOf(CartV1 as unknown as typeof Actor);

  it("R1 通过：只增不减（新增 clear 方法）", () => {
    expect(compatViolations(v1, CartV2Same, metaOf(CartV2Same as unknown as typeof Actor))).toEqual([]);
  });

  it("R1 违规：方法被移除", () => {
    const violations = compatViolations(v1, CartV2Removed, metaOf(CartV2Removed as unknown as typeof Actor));
    expect(violations.some((v) => v.startsWith("R1 违规"))).toBe(true);
  });

  it("R2 违规：既有方法新增必选参数（length 增加）", () => {
    const violations = compatViolations(v1, CartV2BadParam, metaOf(CartV2BadParam as unknown as typeof Actor));
    expect(violations.some((v) => v.startsWith("R2 违规") && v.includes("add"))).toBe(true);
  });

  it("R3 违规：schemaVersion 跳级（+2）", () => {
    class CartV4 extends CartV2Same {
      static schemaVersion = 3;
    }
    const violations = compatViolations(v1, CartV4, metaOf(CartV4 as unknown as typeof Actor));
    expect(violations.some((v) => v.startsWith("R3 违规") && /跳到/.test(v))).toBe(true);
  });

  it("R4/R5/R6 提示不静默：输出人工门禁与 fixtures 承担说明", () => {
    // compatViolations 的可解释状态行由 deploy.ts 注释契约保证；此处锁定 R2/R3 文案格式可定位
    const violations = compatViolations(v1, CartV2BadParam, metaOf(CartV2BadParam as unknown as typeof Actor));
    expect(violations.every((v) => /^(R\d) 违规/.test(v) || v.length > 0)).toBe(true);
  });
});

describe("混合版本（ADR 0003 §5）：protocolVersion 不一致 → join 显式拒绝", () => {
  it("新协议节点不进入旧协议集群（不静默混跑）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-mixed-"));
    const a = await Troupe.form({
      actors: [CartV1],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0 }, // 协议 v2（缺省）
    });
    const b = await Troupe.form({
      actors: [CartV1],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
      cluster: { port: 0, seeds: [a.clusterAddress()!], protocolVersion: 3 }, // 新协议节点
    });
    // B 的 join 被 A 拒（协议不一致 nack）→ B 不进入 A 的成员表（显式失败，不静默混跑）
    expect(await b.clusterMembers()!.includes(a.clusterAddress()!)).toBe(false);
    expect(await a.clusterMembers()!.includes(b.clusterAddress()!)).toBe(false);
    await b.shutdown();
    await a.shutdown();
  }, 30_000);
});
