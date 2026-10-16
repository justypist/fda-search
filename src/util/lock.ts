import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface Lock {
  release: () => void;
}

export class LockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockedError";
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号, 仍算存活
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * 单实例锁。一次完整的 collect (RSS 约 8 分钟 + sitemap 首轮约 22 分钟) 可能长于
 * cron 间隔, 并发运行会重复拉取并互相 requeue 对方的 inflight 任务。这里用锁文件
 * 直接拒绝重入; 进程异常退出留下的陈旧锁 (PID 已不存在) 会被自动接管。
 */
export const acquireLock = (dataDir: string): Lock => {
  const path = join(dataDir, "collect.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let released = false;
      return {
        release: (): void => {
          if (released) return;
          released = true;
          try {
            unlinkSync(path);
          } catch {
            // 锁文件已不存在, 无需处理
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      // 持有者进程仍存活就拒绝重入。这里不豁免"持有者 PID 等于自己": PID 可能被
      // 回收, 那种情况更可能是上次崩溃遗留, 保守拒绝比冒险并发更安全。
      if (Number.isInteger(holder) && isAlive(holder)) {
        throw new LockedError(`已有 collect 在运行 (pid ${holder}), 请等待其结束或删除 ${path}`);
      }
      // 陈旧锁: 持有者已不存在, 清除后重试一次
      try {
        unlinkSync(path);
      } catch {
        throw new LockedError(`无法清除陈旧锁 ${path}`);
      }
    }
  }
  throw new LockedError(`无法获取锁 ${path}`);
};
