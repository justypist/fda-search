import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockedError } from "../src/util/lock.ts";

const withTempDir = (work: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "fda-search-lock-"));
  try {
    work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("锁可获取并释放, 释放后文件被清除", () => {
  withTempDir((dir) => {
    const lock = acquireLock(dir);
    assert.equal(existsSync(join(dir, "collect.lock")), true);
    lock.release();
    assert.equal(existsSync(join(dir, "collect.lock")), false);
  });
});

test("重复释放是安全的 (幂等)", () => {
  withTempDir((dir) => {
    const lock = acquireLock(dir);
    lock.release();
    assert.doesNotThrow(() => lock.release());
  });
});

test("持有者存活时拒绝重入", () => {
  withTempDir((dir) => {
    const lock = acquireLock(dir);
    // 同一进程已有锁, 再次获取必须被拒绝 (PID 相同也是活跃持有者)
    assert.throws(() => acquireLock(dir), LockedError);
    lock.release();
    assert.doesNotThrow(() => acquireLock(dir).release());
  });
});

test("陈旧锁 (持有者已不存在) 会被接管", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "collect.lock"), "999999999\n");
    const lock = acquireLock(dir);
    assert.equal(existsSync(join(dir, "collect.lock")), true);
    lock.release();
  });
});

test("锁文件内容损坏时按陈旧锁处理, 不抛非预期错误", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "collect.lock"), "not-a-pid\n");
    assert.doesNotThrow(() => acquireLock(dir).release());
  });
});
