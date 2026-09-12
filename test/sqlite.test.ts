import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Actor, ConflictError, Troupe } from "../src/index.js";
import { SqlitePropStore } from "../src/props/sqlite.js";
import { unwrapEnvelope, wrapEnvelope } from "../src/core/envelope.js";

function tmpStore(): { store: SqlitePropStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "troupe-sqlite-"));
  return { store: new SqlitePropStore(dir), dir };
}

describe("M2 验收：SqlitePropStore（DESIGN §7.2 CAS 合同）", () => {
  it("create/write/read 往返；revision 单调递增", async () => {
    const { store } = tmpStore();
    const created = await store.create("ns", "Cart", "u1", wrapEnvelope({ a: 1 }, {}), 1);
    expect(created.revision).toBe(1);
    const written = await store.write("ns", "Cart", "u1", wrapEnvelope({ a: 2 }, {}), {
      expectedRevision: 1,
      schemaVersion: 1,
    });
    expect(written.revision).toBe(2);
    const read = await store.read("ns", "Cart", "u1");
    expect(read!.revision).toBe(2);
    expect(unwrapEnvelope(read!.props).props).toEqual({ a: 2 });
  });

  it("create 已存在 → ConflictError(exists)；CAS 不匹配/记录缺失 → ConflictError(revision)", async () => {
    const { store } = tmpStore();
    await store.create("ns", "Cart", "u1", {}, 1);
    const e1 = await store.create("ns", "Cart", "u1", {}, 1).catch((e) => e);
    expect(e1).toBeInstanceOf(ConflictError);
    expect((e1 as ConflictError).kind).toBe("exists");

    const e2 = await store.write("ns", "Cart", "u1", {}, { expectedRevision: 99, schemaVersion: 1 }).catch((e) => e);
    expect((e2 as ConflictError).kind).toBe("revision");

    const e3 = await store.write("ns", "Cart", "ghost", {}, { expectedRevision: 0, schemaVersion: 1 }).catch((e) => e);
    expect((e3 as ConflictError).kind).toBe("revision");
  });

  it("同目录重开实例可见已写入数据（进程级持久）", async () => {
    const { store, dir } = tmpStore();
    await store.create("ns", "Cart", "u1", wrapEnvelope({ items: ["x"] }, {}), 1);
    const reopened = new SqlitePropStore(dir);
    const read = await reopened.read("ns", "Cart", "u1");
    expect(unwrapEnvelope(read!.props).props).toEqual({ items: ["x"] });
  });

  it("delete 后 read 返回 null", async () => {
    const { store } = tmpStore();
    await store.create("ns", "Cart", "u1", {}, 1);
    await store.delete!("ns", "Cart", "u1");
    expect(await store.read("ns", "Cart", "u1")).toBeNull();
  });
});

describe("M2 验收：Troupe × SqlitePropStore（跨下场/跨实例恢复）", () => {
  it("下场保存后，新 Troupe 打开同一库可恢复状态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "troupe-sqlite-"));
    class SqlCartActor extends Actor<{ items: string[] }> {
      static role = "SqlCart";
      static initialProps = () => ({ items: [] });
      async add(item: string) {
        this.props.items.push(item);
        await this.saveProps();
        return this.props.items.length;
      }
      async peek() {
        return this.props.items.length;
      }
    }

    const t1 = await Troupe.form({
      actors: [SqlCartActor],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
    });
    await t1.cast(SqlCartActor, "u1").add("a");
    await t1.cast(SqlCartActor, "u1").add("b");
    await t1.drainAll();

    const t2 = await Troupe.form({
      actors: [SqlCartActor],
      propStore: new SqlitePropStore(dir),
      defaultIntermission: 0,
    });
    expect(await t2.cast(SqlCartActor, "u1").peek()).toBe(2);
    await t2.drainAll();
  });
});
