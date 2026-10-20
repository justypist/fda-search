import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { loadConfig } from "./config.ts";
import { stripSeparators } from "./util/args.ts";

const COMMANDS = ["backup", "upload", "download", "restore"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

const GB = 1024 ** 3;
const MiB = 1024 ** 2;
// GitHub Free 的 Release 附件上限 2 GiB, 留出余量避免卡在边界。
const DEFAULT_PART_BYTES = Math.floor(1.85 * GB);
export const MANIFEST = "manifest.json";
const MANIFEST_VERSION = 1;

export interface Manifest {
  version: number;
  createdAt: string;
  dbBytes: number;
  archiveBytes: number;
  archiveSha256: string;
  partBytes: number;
  parts: string[];
  compression: "zstd" | "store";
  counts: { instances: number; documents: number; alerts: number };
}

interface ArchiveOptions {
  config: string;
  dir: string;
  repo: string | null;
  tag: string | null;
  partBytes: number;
  store: boolean;
  level: number;
  force: boolean;
  verbose: boolean;
}

const USAGE = `数据备份与迁移:

  backup    生成一致性快照, 压缩并按 Release 附件大小分卷
  upload    把备份目录里的分卷传到 GitHub Release
  download  从 GitHub Release 下载分卷到备份目录
  restore   校验分卷并还原为 data/fda-monitor.db

选项:
  -c, --config <路径>  配置文件 (默认 ./monitor.config.json)
      --dir <路径>     备份目录 (默认 ./data/backup)
      --repo <owner/repo>  GitHub 仓库 (默认从 git remote 推断)
      --tag <名称>     Release 标签 (默认 snapshot-YYYY-MM-DD)
      --part <大小>    单个分卷大小, 支持 500M / 2G (默认 1.85G)
      --level <n>      zstd 压缩级别 1-19 (默认 3)
      --store          不压缩直接分卷 (体积约 14G, 仅在内网可用时考虑)
      --force          覆盖已有备份目录 / 目标数据库 / Release 附件
  -v, --verbose        输出更多进度
  -h, --help           显示帮助
`;

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

export const human = (bytes: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};

const SIZE_UNITS: Record<string, number> = { "": 1, K: 1024, M: MiB, G: GB, T: 1024 * GB };

export const parseSize = (raw: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(raw.trim());
  if (match === null) throw new Error(`无法解析体积 ${raw}, 示例: 500M / 2G`);
  const unit = SIZE_UNITS[match[2]?.toUpperCase() ?? ""] ?? 1;
  return Math.floor(Number(match[1]) * unit);
};

export const parseArgs = (argv: string[]): { command: Command; options: ArchiveOptions } => {
  const options: ArchiveOptions = {
    config: "./monitor.config.json",
    dir: "./data/backup",
    repo: null,
    tag: null,
    partBytes: DEFAULT_PART_BYTES,
    store: false,
    level: 3,
    force: false,
    verbose: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺少取值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-c":
      case "--config":
        options.config = next();
        break;
      case "--dir":
        options.dir = next();
        break;
      case "--repo":
        options.repo = next();
        break;
      case "--tag":
        options.tag = next();
        break;
      case "--part":
        options.partBytes = parseSize(next());
        break;
      case "--level": {
        const level = Number(next());
        if (!Number.isInteger(level) || level < 1 || level > 19) throw new Error("--level 需要 1-19 的整数");
        options.level = level;
        break;
      }
      case "--store":
        options.store = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "-v":
      case "--verbose":
        options.verbose = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        if (arg.startsWith("-")) throw new Error(`未知选项 ${arg}`);
        positional.push(arg);
    }
  }
  const command = positional[0];
  if (command === undefined) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!isCommand(command)) throw new Error(`未知命令 ${command}`);
  return { command, options };
};

const say = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const log = (verbose: boolean, message: string): void => {
  if (verbose) say(message);
};

// 进度只写 TTY: 重定向到日志时逐行 \r 会变成垃圾。
const meter = (label: string, total: number): { update: (done: number) => void; done: () => void } => {
  const startedAt = Date.now();
  let lastAt = startedAt;
  const tty = process.stderr.isTTY === true;
  return {
    update: (done: number): void => {
      if (!tty) return;
      const now = Date.now();
      if (now - lastAt < 1_000 && done < total) return;
      lastAt = now;
      const ratio = total === 0 ? 1 : Math.min(1, done / total);
      process.stderr.write(`\r\x1b[K  ${label} ${(ratio * 100).toFixed(1)}% (${human(done)} / ${human(total)}, ${((now - startedAt) / 1000).toFixed(0)}s)`);
    },
    done: (): void => {
      if (tty) process.stderr.write("\r\x1b[K");
    },
  };
};

const sha256File = (path: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code ?? "null"}`))));
  });

// Node 内置 zstd 的 ZSTD_c_nbWorkers 在当前版本会触发 "stream.push() after EOF",
// 只能单线程 (14 GB 约 2 分钟); 系统的 zstd CLI 支持 -T0, 14 GB 约 30 秒。优先 CLI。
const hasZstdCli = (): Promise<boolean> =>
  new Promise((resolvePromise) => {
    const child = spawn("zstd", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });

const compress = async (input: string, output: string, level: number, verbose: boolean): Promise<void> => {
  if (await hasZstdCli()) {
    log(verbose, `系统 zstd (多线程, 级别 ${level})`);
    await run("zstd", ["-T0", `-${level}`, "-q", "-f", "--no-progress", input, "-o", output]);
    return;
  }
  log(verbose, `Node zstd (单线程, 级别 ${level})`);
  const total = statSync(input).size;
  let done = 0;
  const m = meter("压缩", total);
  await pipeline(
    createReadStream(input, { highWaterMark: 4 * MiB }),
    createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } }),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        done += chunk.length;
        m.update(done);
        yield chunk;
      }
    },
    createWriteStream(output),
  );
  m.done();
};

const decompress = async (input: string, output: string, verbose: boolean): Promise<void> => {
  if (await hasZstdCli()) {
    log(verbose, "系统 zstd 解压");
    await run("zstd", ["-d", "-q", "-f", "--no-progress", input, "-o", output]);
    return;
  }
  log(verbose, "Node zstd 解压");
  const total = statSync(input).size;
  let done = 0;
  const m = meter("解压", total);
  await pipeline(
    createReadStream(input, { highWaterMark: 4 * MiB }),
    createZstdDecompress(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        done += chunk.length;
        m.update(done);
        yield chunk;
      }
    },
    createWriteStream(output),
  );
  m.done();
};

// 自己切分而不是调 split(1): 分卷边界要跟 manifest 里的精确字节数一致,
// 且 split 的 -b 不接受小数。任一时刻内存里只有当前 4 MiB 读块。
export const splitFile = async (input: string, dir: string, partBytes: number, suffix: string): Promise<string[]> => {
  const total = statSync(input).size;
  const parts: string[] = [];
  const m = meter("分卷", total);
  let written = 0;
  let out: ReturnType<typeof createWriteStream> | null = null;
  let inPart = 0;
  let opened = false;
  const openNext = (): void => {
    const name = `fda-monitor.db${suffix}.part${String(parts.length).padStart(3, "0")}`;
    parts.push(name);
    inPart = 0;
    opened = true;
    out = createWriteStream(join(dir, name));
  };
  const closePart = async (): Promise<void> => {
    const stream = out;
    out = null;
    if (stream === null) return;
    stream.end();
    await once(stream, "close");
  };
  for await (const chunk of createReadStream(input, { highWaterMark: 4 * MiB })) {
    const buffer = chunk as Buffer;
    let offset = 0;
    while (offset < buffer.length) {
      // 空文件不应产生分卷: 首个非空块到达时才建卷。
      if (!opened) openNext();
      const room = partBytes - inPart;
      const slice = buffer.subarray(offset, offset + Math.min(room, buffer.length - offset));
      if (!out!.write(slice)) await once(out!, "drain");
      offset += slice.length;
      inPart += slice.length;
      written += slice.length;
      if (inPart === partBytes) {
        await closePart();
        opened = false;
      }
    }
    m.update(written);
  }
  await closePart();
  m.done();
  return parts;
};

export const mergeParts = async (dir: string, parts: string[], output: string): Promise<void> => {
  const sink = createWriteStream(output);
  try {
    for (const part of parts) {
      for await (const chunk of createReadStream(join(dir, part), { highWaterMark: 4 * MiB })) {
        if (!sink.write(chunk)) await once(sink, "drain");
      }
    }
  } finally {
    sink.end();
    await once(sink, "close");
  }
};

const capture = (command: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolvePromise(""));
    child.on("close", () => resolvePromise(out.trim()));
  });

export const gitRemoteRepo = async (cwd: string): Promise<string | null> => {
  const parse = (url: string): string | null => {
    const ssh = /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (ssh?.[1] !== undefined) return ssh[1];
    const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return https?.[1] ?? null;
  };
  for (const remote of ["github", "origin"]) {
    const repo = parse(await capture("git", ["remote", "get-url", remote], cwd));
    if (repo !== null) return repo;
  }
  return null;
};
const ghAvailable = (): Promise<boolean> =>
  new Promise((resolvePromise) => {
    const child = spawn("gh", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });

export const defaultTag = (): string => `snapshot-${new Date().toISOString().slice(0, 10)}`;

const readManifest = (dir: string): Manifest => {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) throw new Error(`备份目录 ${dir} 缺少 ${MANIFEST}, 请先运行 backup 或 download`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (parsed.version !== MANIFEST_VERSION) throw new Error(`manifest 版本 ${parsed.version} 不受支持 (期望 ${MANIFEST_VERSION})`);
  return parsed;
};

const countRows = (dbPath: string): Manifest["counts"] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const one = (sql: string): number => Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    return {
      instances: one("SELECT COUNT(*) AS n FROM instances"),
      documents: one("SELECT COUNT(*) AS n FROM documents"),
      alerts: one("SELECT COUNT(*) AS n FROM alerts"),
    };
  } finally {
    db.close();
  }
};

const integrityOk = (dbPath: string): string => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    return String(Object.values(row ?? {})[0] ?? "");
  } finally {
    db.close();
  }
};

const freeBytes = (path: string): number => {
  try {
    const stat = statfsSync(dirname(resolve(path)));
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const requireSpace = (bytes: number, path: string): void => {
  const free = freeBytes(path);
  if (free < bytes) throw new Error(`${dirname(resolve(path))} 需要 ${human(bytes)}, 仅剩 ${human(free)}`);
};

const snapshotTo = async (dbPath: string, target: string): Promise<void> => {
  // 在线备份而不是 cp: WAL 模式下直接复制会丢掉未 checkpoint 的事务,
  // 而 serve / collect 可能正在写。对源库只读, 不打断正在跑的采集。
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const total = statSync(dbPath).size;
    const m = meter("快照", total);
    let last = 0;
    await backup(source, target, {
      rate: 50_000,
      progress: ({ totalPages, remainingPages }) => {
        const ratio = (totalPages - remainingPages) / totalPages;
        if (ratio - last > 0.01 || remainingPages === 0) {
          last = ratio;
          m.update(Math.round(ratio * total));
        }
      },
    });
    m.done();
  } finally {
    source.close();
  }
  // 快照沿用源库的 WAL 模式, 之后任何只读连接都会在备份目录里生成 -shm/-wal。
  // 切成 DELETE 模式, 让快照成为单文件, 分卷目录里不再出现无关文件。
  const snapshot = new DatabaseSync(target);
  try {
    snapshot.exec("PRAGMA journal_mode = DELETE");
  } finally {
    snapshot.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${target}${suffix}`;
    if (existsSync(stale)) unlinkSync(stale);
  }
};

const commandBackup = async (options: ArchiveOptions, cwd: string): Promise<number> => {
  const config = loadConfig(cwd, options.config);
  if (!existsSync(config.dbPath)) return fail(`数据库不存在: ${config.dbPath}`);

  const dir = resolve(cwd, options.dir);
  if (existsSync(join(dir, MANIFEST)) && !options.force) {
    return fail(`备份已存在: ${dir}\n确认要覆盖请加 --force (会删除该目录下的旧分卷)`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const dbBytes = statSync(config.dbPath).size;
  // 峰值出现在压缩阶段: 快照 + 压缩包同时存在。全库已高度压缩 (实测 14 GB -> 6.2 GiB),
  // 按 60% 估压缩包即可, 不必按 2x 原库留空间。
  const expectedArchive = options.store ? dbBytes : Math.ceil(dbBytes * 0.6);
  requireSpace(dbBytes + expectedArchive, join(dir, "x"));
  say(`快照 ${human(dbBytes)} -> ${join(dir, "fda-monitor.db")}`);
  const snapshot = join(dir, "fda-monitor.db");
  await snapshotTo(config.dbPath, snapshot);

  const verdict = integrityOk(snapshot);
  if (verdict !== "ok") return fail(`快照完整性校验失败: ${verdict}`);
  const counts = countRows(snapshot);
  say(`完整性 ok, ${counts.instances} 条元数据 / ${counts.documents} 篇正文 / ${counts.alerts} 条告警`);

  let archive = snapshot;
  if (options.store) {
    say("跳过压缩 (--store)");
  } else {
    say(`压缩 (zstd 级别 ${options.level})`);
    archive = `${snapshot}.zst`;
    await compress(snapshot, archive, options.level, options.verbose);
    unlinkSync(snapshot);
    say(`压缩后 ${human(statSync(archive).size)} (${(statSync(archive).size / dbBytes * 100).toFixed(1)}%)`);
  }

  say("计算 sha256");
  const archiveSha256 = await sha256File(archive);
  const archiveBytes = statSync(archive).size;

  say(`分卷 (每卷 ${human(options.partBytes)})`);
  const parts = await splitFile(archive, dir, options.partBytes, options.store ? "" : ".zst");
  unlinkSync(archive);

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    dbBytes,
    archiveBytes,
    archiveSha256,
    partBytes: options.partBytes,
    parts,
    compression: options.store ? "store" : "zstd",
    counts,
  };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  say(`\n备份完成: ${dir}`);
  say(`  ${parts.length} 卷, 共 ${human(archiveBytes)} (原库 ${human(dbBytes)})`);
  for (const part of parts) say(`  ${part}  ${human(statSync(join(dir, part)).size)}`);
  say("\n上传: pnpm run backup:upload");
  return 0;
};

const commandUpload = async (options: ArchiveOptions, cwd: string): Promise<number> => {
  const dir = resolve(cwd, options.dir);
  const manifest = readManifest(dir);
  const repo = options.repo ?? (await gitRemoteRepo(cwd));
  if (repo === null) return fail("无法确定 GitHub 仓库, 请用 --repo owner/repo 指定");
  if (!(await ghAvailable())) return fail("未找到 gh 命令行, 请先安装 GitHub CLI 并登录");

  const tag = options.tag ?? defaultTag();
  const missing = manifest.parts.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) return fail(`缺少分卷: ${missing.join(", ")}`);

  const visibility = await capture("gh", ["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"], cwd);
  if (visibility === "PUBLIC") {
    say(`注意: ${repo} 是公开仓库, Release 附件会随之下载公开 (${human(manifest.archiveBytes)} 的 FDA 正文与告警)。`);
    say(`      不想公开: gh repo edit ${repo} --visibility private --accept-visibility-change-consequences`);
  }

  const exists = await new Promise<boolean>((resolvePromise) => {
    const child = spawn("gh", ["release", "view", tag, "--repo", repo], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });

  if (!exists) {
    say(`创建 Release ${repo}@${tag}`);
    await run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--title",
      `正文库快照 ${manifest.createdAt.slice(0, 10)}`,
      "--notes",
      `${manifest.counts.instances} 条元数据 / ${manifest.counts.documents} 篇正文 / ${manifest.counts.alerts} 条告警\n\n` +
        `库体积 ${human(manifest.dbBytes)}, 分 ${manifest.parts.length} 卷, 共 ${human(manifest.archiveBytes)}\n\n` +
        `sha256(archive) \`${manifest.archiveSha256}\``,
    ]);
  } else if (!options.force) {
    return fail(`Release ${tag} 已存在。确认要覆盖其中的附件请加 --force`);
  } else {
    say(`复用已有 Release ${repo}@${tag}`);
  }

  say(`上传 ${manifest.parts.length + 1} 个文件 (${human(manifest.archiveBytes)})`);
  const assets = [...manifest.parts, MANIFEST].map((name) => join(dir, name));
  await run("gh", ["release", "upload", tag, ...assets, "--repo", repo, "--clobber"]);
  say(`\n上传完成: https://github.com/${repo}/releases/tag/${tag}`);
  say("目标机执行: pnpm run backup:download && pnpm run backup:restore");
  return 0;
};

const commandDownload = async (options: ArchiveOptions, cwd: string): Promise<number> => {
  const repo = options.repo ?? (await gitRemoteRepo(cwd));
  if (repo === null) return fail("无法确定 GitHub 仓库, 请用 --repo owner/repo 指定");
  if (!(await ghAvailable())) return fail("未找到 gh 命令行, 请先安装 GitHub CLI 并登录");

  const dir = resolve(cwd, options.dir);
  if (existsSync(join(dir, MANIFEST)) && !options.force) {
    return fail(`备份目录已有内容: ${dir}\n确认要重新下载请加 --force`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const tag = options.tag ?? defaultTag();
  say(`从 ${repo}@${tag} 下载 manifest 与分卷 -> ${dir}`);
  await run("gh", ["release", "download", tag, "--repo", repo, "--dir", dir, "--clobber", "--pattern", MANIFEST, "--pattern", "*part*"]);

  const manifest = readManifest(dir);
  const missing = manifest.parts.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) return fail(`下载后仍缺少分卷: ${missing.join(", ")}`);

  say("校验分卷");
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    const size = statSync(join(dir, part)).size;
    const last = index === manifest.parts.length - 1;
    if (!last && size !== manifest.partBytes) return fail(`${part} 体积 ${size}, 期望 ${manifest.partBytes}, 下载不完整`);
    total += size;
  }
  if (total !== manifest.archiveBytes) return fail(`分卷合计 ${total} 字节, manifest 记录 ${manifest.archiveBytes}`);
  requireSpace(manifest.archiveBytes + manifest.dbBytes, join(dir, "fda-monitor.db"));

  say(`下载完成: ${manifest.parts.length} 卷, ${human(manifest.archiveBytes)}`);
  say("\n还原: pnpm run backup:restore");
  return 0;
};

const commandRestore = async (options: ArchiveOptions, cwd: string): Promise<number> => {
  const config = loadConfig(cwd, options.config);
  const dir = resolve(cwd, options.dir);
  const manifest = readManifest(dir);

  const missing = manifest.parts.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) return fail(`缺少分卷: ${missing.join(", ")} (先运行 pnpm run backup:download)`);

  for (const [index, part] of manifest.parts.entries()) {
    const size = statSync(join(dir, part)).size;
    const last = index === manifest.parts.length - 1;
    if (!last && size !== manifest.partBytes) return fail(`${part} 体积 ${size}, 期望 ${manifest.partBytes}, 备份不完整`);
  }

  if (existsSync(config.dbPath) && !options.force) {
    return fail(`目标数据库已存在: ${config.dbPath}\n确认要覆盖请加 --force`);
  }
  requireSpace(manifest.archiveBytes + manifest.dbBytes, config.dbPath);

  // 合并到备份目录里的临时文件, 再解压成快照。若备份目录恰好被指到 dataDir,
  // 固定的 .db 名字会跟目标库同名, 因此用点号前缀的临时名。
  const merged = join(dir, ".restore.tmp");
  say(`合并 ${manifest.parts.length} 卷`);
  await mergeParts(dir, manifest.parts, merged);

  const mergedBytes = statSync(merged).size;
  if (mergedBytes !== manifest.archiveBytes) {
    return fail(`合并后 ${mergedBytes} 字节, manifest 记录 ${manifest.archiveBytes}, 分卷不完整`);
  }

  say("校验 sha256");
  const actual = await sha256File(merged);
  if (actual !== manifest.archiveSha256) return fail(`sha256 不符:\n  期望 ${manifest.archiveSha256}\n  实际 ${actual}`);

  let snapshot = merged;
  if (manifest.compression === "zstd") {
    say("解压");
    snapshot = join(dir, ".restore.db");
    await decompress(merged, snapshot, options.verbose);
    unlinkSync(merged);
    // zstd 帧自带内容校验和, 解压后字节数对不上说明数据损坏
    if (statSync(snapshot).size !== manifest.dbBytes) return fail(`解压后 ${statSync(snapshot).size} 字节, 期望 ${manifest.dbBytes}`);
  }

  const verdict = integrityOk(snapshot);
  if (verdict !== "ok") return fail(`完整性校验失败: ${verdict}`);
  const counts = countRows(snapshot);
  if (counts.documents !== manifest.counts.documents) {
    return fail(`正文数 ${counts.documents} 与 manifest 的 ${manifest.counts.documents} 不符`);
  }
  say(`完整性 ok, ${counts.instances} 条元数据 / ${counts.documents} 篇正文 / ${counts.alerts} 条告警`);

  // WAL / SHM 属于旧库的连接状态, 保留会让新库读到半截数据;
  // collect.lock 里的 PID 在新机器上无意义, 留着会误判"已有 collect 在运行"。
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${config.dbPath}${suffix}`;
    if (existsSync(stale)) {
      unlinkSync(stale);
      say(`已删除旧的 ${stale}`);
    }
  }
  const lock = join(config.dataDir, "collect.lock");
  if (existsSync(lock)) {
    unlinkSync(lock);
    say(`已删除陈旧的 ${lock}`);
  }

  mkdirSync(dirname(config.dbPath), { recursive: true });
  // 备份目录可能挂在另一个文件系统上, rename 会 EXDEV; 先落到目标目录再原子替换。
  const staged = `${config.dbPath}.restore-tmp`;
  copyFileSync(snapshot, staged);
  unlinkSync(snapshot);
  renameSync(staged, config.dbPath);
  say(`\n已还原到 ${config.dbPath}`);
  say("验证: pnpm run status");
  return 0;
};

const main = async (): Promise<number> => {
  const { command, options } = parseArgs(stripSeparators(process.argv.slice(2)));
  const cwd = process.cwd();
  switch (command) {
    case "backup":
      return commandBackup(options, cwd);
    case "upload":
      return commandUpload(options, cwd);
    case "download":
      return commandDownload(options, cwd);
    case "restore":
      return commandRestore(options, cwd);
  }
};

// 仅在被直接执行时跑 CLI。测试会 import 本模块拿纯函数, 不能触发 main。
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
};

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
