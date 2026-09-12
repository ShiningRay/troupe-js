/**
 * 集群基准的子进程 Stage 夹具（一个 OS 进程 = 一个 Stage）：
 *   node --import tsx examples/bench/bench-stage.ts --dir <sqliteDir> --seeds <addr>
 * 提供 BenchActor：echo（纯路由）/ echoSave（含 SQLite 落盘）。
 */
import { parseArgs } from "node:util";
import { Actor, Troupe } from "../../src/index.js";
import { SqlitePropStore } from "../../src/props/sqlite.js";

export interface BenchProps {
  n: number;
}

export class BenchActor extends Actor<BenchProps> {
  static role = "Bench";
  static initialProps = (): BenchProps => ({ n: 0 });

  /** 纯路由：payload 原样往返（测量 编解码 + 串行 Turn + 线路） */
  async echo(payload: string): Promise<string> {
    return payload;
  }

  /** 含持久化：每次调用 saveProps（测量 + SQLite 落盘） */
  async echoSave(payload: string): Promise<string> {
    this.props.n++;
    await this.saveProps();
    return payload;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: "./.troupe/bench" },
      seeds: { type: "string", default: "" },
    },
  });
  const troupe = await Troupe.form({
    actors: [BenchActor],
    propStore: new SqlitePropStore(values.dir!),
    defaultIntermission: 0,
    defaultTimeout: "30s",
    cluster: { port: 0, seeds: values.seeds ? values.seeds.split(",") : [] },
  });
  console.log(`READY addr=${troupe.clusterAddress()} pid=${process.pid}`);

  const stop = async (signal: string) => {
    await troupe.shutdown();
    console.log(`STAGE_EXIT(${signal})`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// 仅在被直接执行时启动（被 cluster-bench 导入 BenchActor 时不启动）
if (process.argv[1]?.includes("bench-stage")) {
  void main();
}
