import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { gitRemoteRepo, human, mergeParts, parseSize, splitFile } from "../src/archive.ts";

const withTempDir = async (work: (dir: string) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "fda-search-archive-"));
  try {
    await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("体积解析: 支持单位后缀与小数", () => {
  assert.equal(parseSize("500M"), 500 * 1024 ** 2);
  assert.equal(parseSize("1.85G"), Math.floor(1.85 * 1024 ** 3));
  assert.equal(parseSize("2GiB"), 2 * 1024 ** 3);
  assert.equal(parseSize("4096"), 4096);
  assert.equal(parseSize(" 10 K "), 10 * 1024);
});

test("体积解析: 非法输入抛错而不是静默取默认值", () => {
  assert.throws(() => parseSize("abc"));
  assert.throws(() => parseSize("10X"));
});

test("体积格式化: 按 1024 进制并保留两位小数", () => {
  assert.equal(human(0), "0 B");
  assert.equal(human(1024), "1.00 KiB");
  assert.equal(human(14 * 1024 ** 3), "14.00 GiB");
});

test("分卷: 边界精确, 每卷不超上限, 末卷收尾", async () => {
  await withTempDir(async (dir) => {
    // 故意用不能被 4096 整除的尺寸, 覆盖跨读块边界的切分
    const payload = randomBytes(10_000);
    const source = join(dir, "blob.bin");
    writeFileSync(source, payload);

    const parts = await splitFile(source, dir, 4_096, ".zst");
    assert.deepEqual(parts, ["fda-monitor.db.zst.part000", "fda-monitor.db.zst.part001", "fda-monitor.db.zst.part002"]);
    assert.equal(statSync(join(dir, parts[0]!)).size, 4_096);
    assert.equal(statSync(join(dir, parts[1]!)).size, 4_096);
    assert.equal(statSync(join(dir, parts[2]!)).size, 10_000 - 8_192);
  });
});

test("分卷: 内容按顺序拼回后与原文逐字节一致", async () => {
  await withTempDir(async (dir) => {
    const payload = randomBytes(50_000);
    const source = join(dir, "blob.bin");
    writeFileSync(source, payload);
    const parts = await splitFile(source, dir, 7_777, "");

    const merged = join(dir, "merged.bin");
    await mergeParts(dir, parts, merged);
    assert.equal(statSync(merged).size, payload.length);

    const digest = (path: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(path)
          .on("data", (chunk) => hash.update(chunk))
          .on("error", reject)
          .on("end", () => resolve(hash.digest("hex")));
      });
    assert.equal(await digest(merged), createHash("sha256").update(payload).digest("hex"));
  });
});

test("分卷: 恰好整除时不留空卷", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "blob.bin");
    writeFileSync(source, randomBytes(8_192));
    const parts = await splitFile(source, dir, 4_096, "");
    assert.equal(parts.length, 2);
    assert.equal(statSync(join(dir, parts[1]!)).size, 4_096);
  });
});

test("分卷: 空文件不产生分卷, merge 得到空文件", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "empty.bin");
    writeFileSync(source, "");
    assert.deepEqual(await splitFile(source, dir, 4_096, ""), []);
    const merged = join(dir, "merged.bin");
    await mergeParts(dir, [], merged);
    assert.equal(statSync(merged).size, 0);
  });
});

test("压缩往返: Node zstd 单线程可用 (多线程参数在 Node 24 会报 push after EOF)", async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.from("listeria ".repeat(100_000));
    const source = join(dir, "in.bin");
    const packed = join(dir, "out.zst");
    const restored = join(dir, "back.bin");
    writeFileSync(source, payload);

    await pipeline(createReadStream(source), createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } }), createWriteStream(packed));
    assert.ok(statSync(packed).size < payload.length);

    await pipeline(createReadStream(packed), createZstdDecompress(), createWriteStream(restored));
    assert.deepEqual(statSync(restored).size, payload.length);
  });
});

test("remote 解析: 从 git remote 推断 owner/repo", async () => {
  await withTempDir(async (dir) => {
    const git = (...args: string[]): void => {
      const result = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
      assert.equal(result.status, 0, `git ${args.join(" ")} 失败`);
    };
    git("init", "-q");
    git("remote", "add", "github", "git@github.com:justypist/fda-search.git");
    assert.equal(await gitRemoteRepo(dir), "justypist/fda-search");

    git("remote", "set-url", "github", "https://github.com/owner/repo.git");
    assert.equal(await gitRemoteRepo(dir), "owner/repo");

    git("remote", "set-url", "github", "git@t:fda-search.git");
    // 自建服务只有服务器没有 owner 路径, 应跳过并回落到 origin
    git("remote", "add", "origin", "git@github.com:fallback/repo.git");
    assert.equal(await gitRemoteRepo(dir), "fallback/repo");
  });
});
