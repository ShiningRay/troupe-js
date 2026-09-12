import { describe, expect, it } from "vitest";
import { IdempotencyConflictError, Troupe } from "../src/index.js";
import { InMemoryPropStore } from "../src/props/memory.js";
import { RoomActor } from "../examples/chat/server.js";

async function chatTroupe() {
  return Troupe.form({
    actors: [RoomActor],
    propStore: new InMemoryPropStore(),
    defaultIntermission: 0,
  });
}

describe("聊天室 demo：RoomActor 语义", () => {
  it("join/leave/since：成员管理与历史游标", async () => {
    const troupe = await chatTroupe();
    const room = troupe.cast(RoomActor, "lobby");
    expect(await room.join("alice")).toEqual(["alice"]);
    expect(await room.join("bob")).toEqual(["alice", "bob"]);
    expect(await room.join("alice")).toEqual(["alice", "bob"]); // 去重

    await room.send("m1", "alice", "hello");
    await room.send("m2", "bob", "hi");
    expect((await room.since(0)).map((m) => m.text)).toEqual(["hello", "hi"]);
    expect((await room.since(1)).map((m) => m.text)).toEqual(["hi"]); // 游标增量

    expect(await room.leave("alice")).toEqual(["bob"]);
    await troupe.drainAll();
  });

  it("幂等发送：同 msgId 同内容重放不重复；不同内容拒绝；历史封顶 200", async () => {
    const troupe = await chatTroupe();
    const room = troupe.cast(RoomActor, "lobby");
    const first = await room.send("m1", "alice", "hello");
    const replay = await room.send("m1", "alice", "hello"); // 网络重试
    expect(replay.id).toBe(first.id);
    expect((await room.since(0)).length).toBe(1); // 只有一条

    const conflict = await room.send("m1", "alice", "different").catch((e) => e);
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);

    for (let i = 0; i < 210; i++) await room.send(`bulk-${i}`, "bot", `msg-${i}`);
    expect((await room.since(0)).length).toBe(200); // 历史封顶
    await troupe.drainAll();
  });
});
