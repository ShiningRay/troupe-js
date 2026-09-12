/**
 * M3 混沌测试夹具：可被 SIGSTOP 冻结事件循环的独立 Stage 进程。
 *
 * 用法：node --import tsx test/fixtures/pausable-stage.ts --dir <sqliteDir> --seeds <addr> [--lease 600]
 * stdout 行协议：
 *   READY addr=<addr> pid=<pid>
 *   KEY <stageName>     （自选归属键并写入一笔，持有所有权）
 *   EPOCH <n>           （保存的 fencing token）
 * stdin 命令：
 *   try-write           （以保存的旧 epoch 直接 store.write → 输出 WROTE 或 FENCED <msg>）
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Actor, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";
import { wrapEnvelope } from "../../src/core/envelope.js";

class ChaosCartActor extends Actor<{ items: string[] }> {
  static role = "ChaosCart";
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

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    seeds: { type: "string", default: "" },
    lease: { type: "string", default: "600" },
  },
});

const store = new SqlitePropStore(values.dir!);
const troupe = await Troupe.form({
  actors: [ChaosCartActor],
  propStore: store,
  defaultIntermission: 0,
  defaultTimeout: "10s",
  cluster: { port: 0, seeds: values.seeds ? values.seeds.split(",") : [] },
  ownership: { leaseMs: Number(values.lease) },
});
console.log(`READY addr=${troupe.clusterAddress()} pid=${process.pid}`);

// 等 join 收敛后挑一个归属自己的键并写入（由此持有所有权）
await new Promise((r) => setTimeout(r, 400));
let key = "";
for (let i = 0; i < 1000; i++) {
  if (troupe.ownerOf("ChaosCart", `k${i}`) === troupe.clusterAddress()) {
    key = `k${i}`;
    break;
  }
}
await troupe.cast(ChaosCartActor, key).add("one");
const own = await store.readOwnership("default", "ChaosCart", key);
const rev = (await store.read("default", "ChaosCart", key))!.revision;
console.log(`KEY ${key}`);
console.log(`EPOCH ${own!.epoch}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() !== "try-write") return;
  void (async () => {
    try {
      await store.write(
        "default", "ChaosCart", key,
        wrapEnvelope({ items: ["stale-write-from-paused-holder"] }, {}),
        { expectedRevision: rev, schemaVersion: 1, fencingToken: own!.epoch },
      );
      console.log("WROTE");
    } catch (e) {
      console.log(`FENCED ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  })();
});
