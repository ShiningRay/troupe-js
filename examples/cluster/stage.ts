/**
 * 独立 Stage 进程（example:cluster 的子进程，一个 OS 进程 = 一个 Stage）：
 *   tsx examples/cluster/stage.ts --name B --port 0 --seeds 127.0.0.1:7400 --dir /tmp/xxx
 *
 * 行为：入团 → 每 5s 心跳打印（成员/在场 Actor）→ SIGTERM/SIGINT 优雅停机
 */
import { parseArgs } from "node:util";
import { Actor, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "stage" },
    port: { type: "string", default: "0" },
    seeds: { type: "string", default: "" },
    dir: { type: "string", default: "./.troupe" },
    booth: { type: "boolean", default: false },
    "booth-port": { type: "string", default: "" },
    lease: { type: "string", default: "" },
  },
});

class ClusCartActor extends Actor<{ items: string[] }> {
  static role = "ClusCart";
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

const troupe = await Troupe.form({
  actors: [ClusCartActor],
  propStore: new SqlitePropStore(values.dir!),
  defaultIntermission: 0,
  defaultTimeout: "10s",
  cluster: { port: Number(values.port), seeds: values.seeds ? values.seeds.split(",") : [] },
  booth: values.booth ? { port: values["booth-port"] ? Number(values["booth-port"]) : 0 } : false,
  // M3 所有权：租约 + fencing（kill -9 接管需等租约到期，lease 越短接管越快、续期越频繁）
  ...(values.lease ? { ownership: { leaseMs: Number(values.lease) } } : {}),
});

console.log(
  `STAGE_READY name=${values.name} addr=${troupe.clusterAddress()} pid=${process.pid}` +
    (troupe.boothAddress() ? ` booth=${troupe.boothAddress()}` : ""),
);

setInterval(() => {
  console.log(
    `heartbeat members=[${troupe.clusterMembers()!.join(", ")}] 在场=${troupe.slots().length} pid=${process.pid}`,
  );
}, 5_000);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`收到 ${signal}，优雅停机（leave → 排空 → 保存）…`);
  await troupe.shutdown();
  console.log("STAGE_EXIT");
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
