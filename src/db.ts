import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Cursor, DatasetState, FeedState, Item, QueueMessage, QueueRow, QueueState, SourceKind } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT
);

CREATE TABLE IF NOT EXISTS queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  channel    TEXT NOT NULL,
  cursor     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_id     INTEGER NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, channel, cursor)
);
CREATE INDEX IF NOT EXISTS queue_state_idx ON queue (state, id);

CREATE TABLE IF NOT EXISTS instances (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  channel      TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  url          TEXT NOT NULL,
  published_at TEXT,
  first_seen   TEXT NOT NULL,
  raw          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS instances_channel_idx ON instances (channel, published_at);
-- 正文抓取按 lastmod 倒序取待抓项, 这条索引让那个查询不必全表排序
CREATE INDEX IF NOT EXISTS instances_source_published_idx ON instances (source, published_at DESC);
CREATE INDEX IF NOT EXISTS instances_url_idx ON instances (url);

CREATE TABLE IF NOT EXISTS matches (
  item_id    TEXT NOT NULL,
  rule       TEXT NOT NULL,
  field      TEXT NOT NULL,
  term       TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, rule, term)
);

CREATE TABLE IF NOT EXISTS alerts (
  item_id    TEXT NOT NULL,
  rule       TEXT NOT NULL,
  run_id     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, rule)
);
CREATE INDEX IF NOT EXISTS alerts_run_idx ON alerts (run_id);

CREATE TABLE IF NOT EXISTS cursors (
  channel    TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_state (
  channel       TEXT PRIMARY KEY,
  last_modified TEXT,
  fingerprint   TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sitemap_pages (
  channel       TEXT PRIMARY KEY,
  last_modified TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_state (
  channel      TEXT PRIMARY KEY,
  last_updated TEXT,
  scanned_at   TEXT NOT NULL
);

-- 已抓取的正文。与 instances 分表存放: instances 是"条目元数据"(轻, 全部通道共用),
-- documents 是"正文"(重, 只有正文通道写入), 分开后 instances 的查询不受大字段拖累。
CREATE TABLE IF NOT EXISTS documents (
  url          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  text         TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  chars        INTEGER NOT NULL DEFAULT 0,
  etag         TEXT,
  last_modified TEXT,
  fetched_at   TEXT NOT NULL,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS documents_kind_idx ON documents (kind);
`;

// FTS5 索引单独建: 老版本的 SQLite 可能没编译 FTS5, 届时降级为纯 LIKE 检索而不是启动失败。
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title,
  text,
  content='documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts (documents_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO documents_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
`;

export interface RunStats {
  produced: number;
  matched: number;
  fetched: number;
}

export interface RunSummary {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  stats: RunStats | null;
}

export interface AlertRecord {
  item: Item;
  rule: string;
  matchedAt: string;
}

export interface DocumentRecord {
  url: string;
  kind: string;
  title: string;
  chars: number;
  bytes: number;
  fetchedAt: string;
  error: string | null;
}

export interface DocumentHit extends DocumentRecord {
  snippet: string;
  rank: number;
}

const asRow = <T>(value: unknown): T | null => (value === undefined || value === null ? null : (value as T));

const asRows = <T>(value: unknown): T[] => value as T[];

const str = (value: unknown): string => String(value ?? "");
const num = (value: unknown): number => Number(value ?? 0);
const nullableStr = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export class Store {
  readonly #db: DatabaseSync;
  readonly #stmts = new Map<string, StatementSync>();
  readonly #fts: boolean;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 10000");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#fts = this.#setupFts();
    this.#migrate();
  }

  #setupFts(): boolean {
    try {
      this.#db.exec(FTS_SCHEMA);
      this.#db.exec(FTS_TRIGGERS);
      return true;
    } catch {
      return false;
    }
  }

  get ftsEnabled(): boolean {
    return this.#fts;
  }

  // 轻量迁移: SQLite 的 ADD COLUMN 是幂等的失败即已存在, 忽略即可。
  #migrate(): void {
    for (const statement of ["ALTER TABLE feed_state ADD COLUMN fingerprint TEXT"]) {
      try {
        this.#db.exec(statement);
      } catch {
        // 列已存在
      }
    }
  }

  #stmt(sql: string): StatementSync {
    const cached = this.#stmts.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#stmts.set(sql, prepared);
    return prepared;
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  startRun(startedAt: string): number {
    const result = this.#stmt("INSERT INTO runs (started_at) VALUES (?)").run(startedAt);
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, finishedAt: string, stats: RunStats): void {
    this.#stmt("UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?").run(finishedAt, JSON.stringify(stats), id);
  }

  listRuns(limit: number): RunSummary[] {
    const rows = asRows<Record<string, unknown>>(
      this.#stmt("SELECT id, started_at, finished_at, stats FROM runs ORDER BY id DESC LIMIT ?").all(limit),
    );
    return rows.map((row) => ({
      id: num(row.id),
      startedAt: str(row.started_at),
      finishedAt: nullableStr(row.finished_at),
      stats: row.stats === null || row.stats === undefined ? null : (JSON.parse(str(row.stats)) as RunStats),
    }));
  }

  enqueue(messages: QueueMessage[], now: string): number {
    const statement = this.#stmt(
      `INSERT OR IGNORE INTO queue (source, channel, cursor, payload, state, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    );
    return this.#transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        const result = statement.run(
          message.source,
          message.channel,
          message.cursor,
          JSON.stringify(message.payload),
          message.runId,
          now,
          now,
        );
        inserted += Number(result.changes);
      }
      return inserted;
    });
  }

  topPendingChannels(limit: number): string[] {
    const rows = asRows<Record<string, unknown>>(
      this.#stmt(
        "SELECT channel, MIN(id) AS id FROM queue WHERE state = 'pending' GROUP BY channel ORDER BY id LIMIT ?",
      ).all(limit),
    );
    return rows.map((row) => str(row.channel));
  }

  pendingCount(): number {
    return this.#count("SELECT COUNT(*) AS total FROM queue WHERE state = 'pending'");
  }

  failedCount(): number {
    return this.#count("SELECT COUNT(*) AS total FROM queue WHERE state = 'failed'");
  }

  #count(sql: string): number {
    const row = asRow<Record<string, unknown>>(this.#stmt(sql).get());
    return row === null ? 0 : num(row.total);
  }

  claimNext(channel: string, now: string): QueueRow | null {
    return this.#transaction(() => {
      const raw = asRow<Record<string, unknown>>(
        this.#stmt(
          `SELECT id, source, channel, cursor, payload, state, attempts, run_id AS runId, error, created_at AS createdAt, updated_at AS updatedAt
           FROM queue WHERE state = 'pending' AND channel = ? ORDER BY id LIMIT 1`,
        ).get(channel),
      );
      if (raw === null) return null;
      const row: QueueRow = {
        id: num(raw.id),
        source: str(raw.source) as SourceKind,
        channel: str(raw.channel),
        cursor: str(raw.cursor),
        payload: str(raw.payload),
        state: "inflight",
        attempts: num(raw.attempts) + 1,
        runId: num(raw.runId),
        error: nullableStr(raw.error),
        createdAt: str(raw.createdAt),
        updatedAt: str(raw.updatedAt),
      };
      this.#stmt("UPDATE queue SET state = 'inflight', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      return row;
    });
  }

  finish(id: number, state: QueueState, error: string | null, now: string): void {
    // 处理完成后立即丢弃 payload: 条目已落库, 载荷不再需要, 而 sitemap 单批
    // 载荷可达 15MB, 若永久保留会让数据库无限增长。
    this.#stmt("UPDATE queue SET state = ?, error = ?, payload = '', updated_at = ? WHERE id = ?").run(state, error, now, id);
  }

  // 定期清理已完成的队列行。保留少量历史便于排查, 其余按保留窗口删除。
  pruneQueue(keepDays: number, keepRows: number, now: string): number {
    const cutoff = new Date(Date.parse(now) - keepDays * 86_400_000).toISOString();
    const result = this.#stmt(
      `DELETE FROM queue WHERE state IN ('done', 'failed') AND updated_at < ?
       AND id NOT IN (SELECT id FROM queue WHERE state IN ('done', 'failed') ORDER BY id DESC LIMIT ?)`,
    ).run(cutoff, keepRows);
    return Number(result.changes);
  }

  vacuum(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  requeueStale(now: string): number {
    const result = this.#stmt("UPDATE queue SET state = 'pending', updated_at = ? WHERE state = 'inflight'").run(now);
    return Number(result.changes);
  }

  #feedState(sql: string, channel: string | null): FeedState[] {
    const rows = asRows<Record<string, unknown>>(channel === null ? this.#stmt(sql).all() : this.#stmt(sql).all(channel));
    return rows.map((row) => ({
      channel: str(row.channel),
      lastModified: nullableStr(row.lastModified),
      fingerprint: nullableStr(row.fingerprint),
      fetchedAt: str(row.fetchedAt),
    }));
  }

  getCursor(channel: string): string | null {
    const row = asRow<Record<string, unknown>>(
      this.#stmt("SELECT cursor FROM cursors WHERE channel = ?").get(channel),
    );
    return row === null ? null : str(row.cursor);
  }

  listCursors(): Cursor[] {
    const rows = asRows<Record<string, unknown>>(
      this.#stmt("SELECT channel, cursor, updated_at AS updatedAt FROM cursors ORDER BY channel").all(),
    );
    return rows.map((row) => ({ channel: str(row.channel), cursor: str(row.cursor), updatedAt: str(row.updatedAt) }));
  }

  setCursor(channel: string, cursor: string, now: string): void {
    this.#stmt(
      `INSERT INTO cursors (channel, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(channel, cursor, now);
  }

  getFeedState(channel: string): FeedState | null {
    return (
      this.#feedState("SELECT channel, last_modified AS lastModified, fingerprint, fetched_at AS fetchedAt FROM feed_state WHERE channel = ?", channel)[0] ?? null
    );
  }

  listFeedStates(): FeedState[] {
    return this.#feedState("SELECT channel, last_modified AS lastModified, fingerprint, fetched_at AS fetchedAt FROM feed_state ORDER BY channel", null);
  }

  setFeedState(channel: string, lastModified: string | null, now: string, fingerprint: string | null = null): void {
    this.#stmt(
      `INSERT INTO feed_state (channel, last_modified, fingerprint, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET last_modified = excluded.last_modified,
                                           fingerprint = excluded.fingerprint,
                                           fetched_at = excluded.fetched_at`,
    ).run(channel, lastModified, fingerprint, now);
  }

  getSitemapPage(channel: string): FeedState | null {
    return (
      this.#feedState("SELECT channel, last_modified AS lastModified, fetched_at AS fetchedAt FROM sitemap_pages WHERE channel = ?", channel)[0] ?? null
    );
  }

  setSitemapPage(channel: string, lastModified: string | null, now: string): void {
    this.#stmt(
      `INSERT INTO sitemap_pages (channel, last_modified, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET last_modified = excluded.last_modified, fetched_at = excluded.fetched_at`,
    ).run(channel, lastModified, now);
  }

  sitemapPageCount(): number {
    return this.#count("SELECT COUNT(*) AS total FROM sitemap_pages");
  }

  getDatasetState(channel: string): DatasetState {
    const row = asRow<Record<string, unknown>>(
      this.#stmt("SELECT last_updated AS lastUpdated, scanned_at AS scannedAt FROM dataset_state WHERE channel = ?").get(channel),
    );
    return {
      channel,
      lastUpdated: row === null ? null : nullableStr(row.lastUpdated),
      scannedAt: row === null ? null : str(row.scannedAt),
    };
  }

  listDatasetStates(): DatasetState[] {
    const rows = asRows<Record<string, unknown>>(
      this.#stmt("SELECT channel, last_updated AS lastUpdated, scanned_at AS scannedAt FROM dataset_state ORDER BY channel").all(),
    );
    return rows.map((row) => ({
      channel: str(row.channel),
      lastUpdated: nullableStr(row.lastUpdated),
      scannedAt: str(row.scannedAt),
    }));
  }

  setDatasetState(channel: string, lastUpdated: string | null, scannedAt: string): void {
    this.#stmt(
      `INSERT INTO dataset_state (channel, last_updated, scanned_at) VALUES (?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET last_updated = excluded.last_updated, scanned_at = excluded.scanned_at`,
    ).run(channel, lastUpdated, scannedAt);
  }

  commitItems(
    items: Item[],
    matches: { itemId: string; rule: string; field: string; term: string }[],
    runId: number,
    now: string,
  ): { inserted: number; alerted: number } {
    const insertItem = this.#stmt(
      `INSERT INTO instances (id, source, channel, title, summary, url, published_at, first_seen, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    );
    const insertMatch = this.#stmt(
      "INSERT OR IGNORE INTO matches (item_id, rule, field, term, matched_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAlert = this.#stmt(
      "INSERT OR IGNORE INTO alerts (item_id, rule, run_id, created_at) VALUES (?, ?, ?, ?)",
    );

    return this.#transaction(() => {
      let inserted = 0;
      let alerted = 0;
      const fresh = new Set<string>();
      for (const item of items) {
        const result = insertItem.run(
          item.id,
          item.source,
          item.channel,
          item.title,
          item.summary,
          item.url,
          item.date,
          now,
          JSON.stringify(item),
        );
        if (Number(result.changes) > 0) {
          inserted += 1;
          fresh.add(item.id);
        } else if (item.date !== null) {
          // 已存在: 只刷新 lastmod。sitemap 重扫时同一 URL 的 lastmod 会前进,
          // 而 INSERT ... DO NOTHING 不更新任何列 —— 若不单独刷新, 正文抓取
          // 的"按 lastmod 倒序"会永远用首次见到时的旧时间排序。
          // 这里不碰 title/summary/raw: 那些由首次写入的通道决定, 后到的通道
          // (例如 rss) 不应覆盖。
          this.#stmt("UPDATE instances SET published_at = ? WHERE id = ? AND published_at IS NOT ?").run(item.date, item.id, item.date);
        }
      }
      for (const match of matches) {
        insertMatch.run(match.itemId, match.rule, match.field, match.term, now);
        if (!fresh.has(match.itemId)) continue;
        const result = insertAlert.run(match.itemId, match.rule, runId, now);
        alerted += Number(result.changes);
      }
      return { inserted, alerted };
    });
  }

  saveDocument(record: {
    url: string;
    kind: string;
    title: string;
    text: string;
    bytes: number;
    etag: string | null;
    lastModified: string | null;
    fetchedAt: string;
    error: string | null;
  }): void {
    this.#stmt(
      `INSERT INTO documents (url, kind, title, text, bytes, chars, etag, last_modified, fetched_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET kind = excluded.kind, title = excluded.title, text = excluded.text,
                                       bytes = excluded.bytes, chars = excluded.chars, etag = excluded.etag,
                                       last_modified = excluded.last_modified, fetched_at = excluded.fetched_at,
                                       error = excluded.error`,
    ).run(
      record.url,
      record.kind,
      record.title,
      record.text,
      record.bytes,
      record.text.length,
      record.etag,
      record.lastModified,
      record.fetchedAt,
      record.error,
    );
  }

  // 正文抓取的进度与"跳过"判据: 已成功抓过且 etag/last_modified 未变即可跳过。
  getDocumentState(url: string): { fetchedAt: string; etag: string | null; lastModified: string | null; chars: number; error: string | null } | null {
    const row = asRow<Record<string, unknown>>(
      this.#stmt("SELECT fetched_at, etag, last_modified, chars, error FROM documents WHERE url = ?").get(url),
    );
    if (row === null) return null;
    return {
      fetchedAt: str(row.fetched_at),
      etag: nullableStr(row.etag),
      lastModified: nullableStr(row.last_modified),
      chars: num(row.chars),
      error: nullableStr(row.error),
    };
  }

  // 取"还没抓过正文"的 sitemap URL, 已抓过的 (无论成败) 不再返回, 保证批次单调前进。
  //
  // 过滤条件必须下推到 SQL: 若先取固定窗口再在内存里按 include 过滤, 窄条件
  // (例如只要 /media/) 会永远只看到列表最前面那一批不匹配的 URL, 一篇也抓不到。
  pendingDocumentUrls(filter: { include: string[]; exclude: string[] }, limit: number): string[] {
    const where: string[] = ["i.source = 'sitemap'", "d.url IS NULL"];
    const args: (string | number)[] = [];
    if (filter.exclude.length > 0) {
      where.push(`NOT (${filter.exclude.map(() => "i.url LIKE ?").join(" OR ")})`);
      for (const pattern of filter.exclude) args.push(`%${pattern}%`);
    }
    if (filter.include.length > 0) {
      where.push(`(${filter.include.map(() => "i.url LIKE ?").join(" OR ")})`);
      for (const pattern of filter.include) args.push(`%${pattern}%`);
    }
    // 按 lastmod 倒序: 优先抓"最近变过"的页面。全量 86,699 个 URL 在
    // Crawl-delay: 30 下需约 30 天, 而真正在变的内容只占很小一部分
    // (实测近 30 天有变动的内容页仅 779 个)。倒序让有用的部分几天内就绪,
    // 陈年归档留到最后慢慢补。
    //
    // 排序键不用 "NULLS LAST": 该语法要 SQLite >= 3.30, 而内置 SQLite 版本
    // 随 Node 走, 这里不依赖它。改为显式把 NULL 排到最后。
    const rows = asRows<Record<string, unknown>>(
      this.#stmt(
        `SELECT i.url FROM instances i
         LEFT JOIN documents d ON d.url = i.url
         WHERE ${where.join(" AND ")}
         ORDER BY (i.published_at IS NULL), i.published_at DESC, i.url LIMIT ?`,
      ).all(...args, limit),
    );
    return rows.map((row) => str(row.url));
  }

  pendingDocumentCount(): number {
    return this.#count(
      `SELECT COUNT(*) AS total FROM instances i
       LEFT JOIN documents d ON d.url = i.url
       WHERE i.source = 'sitemap' AND d.url IS NULL`,
    );
  }

  documentTitle(url: string): string {
    const row = asRow<Record<string, unknown>>(this.#stmt("SELECT title FROM instances WHERE url = ?").get(url));
    return row === null ? "" : str(row.title);
  }

  // 304 路径: 只刷新抓取时间与 etag, 不动正文。
  touchDocument(url: string, oldEtag: string | null, newEtag: string | null, now: string): void {
    this.#stmt("UPDATE documents SET fetched_at = ?, etag = ? WHERE url = ?").run(now, newEtag ?? oldEtag, url);
  }

  // 记录 301 别名: 把重定向目标也写进 documents, 避免它被当成待抓项重复抓取。
  aliasDocument(from: string, to: string, now: string): void {
    const existing = this.getDocumentState(to);
    if (existing !== null) return;
    const row = asRow<Record<string, unknown>>(
      this.#stmt("SELECT url, kind, title, text, bytes, etag, last_modified, fetched_at, error FROM documents WHERE url = ?").get(from),
    );
    if (row === null) return;
    this.#stmt(
      `INSERT OR IGNORE INTO documents (url, kind, title, text, bytes, chars, etag, last_modified, fetched_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(to, str(row.kind), str(row.title), str(row.text), num(row.bytes), num(row.chars), nullableStr(row.etag), nullableStr(row.last_modified), now, nullableStr(row.error));
  }

  documentStats(): { total: number; ok: number; failed: number; chars: number; byKind: { kind: string; n: number }[] } {
    const row = asRow<Record<string, unknown>>(
      this.#stmt(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN error IS NULL THEN 0 ELSE 1 END) AS failed,
                SUM(chars) AS chars FROM documents`,
      ).get(),
    );
    const byKind = asRows<Record<string, unknown>>(
      this.#stmt("SELECT kind, COUNT(*) AS n FROM documents GROUP BY kind ORDER BY n DESC").all(),
    ).map((r) => ({ kind: str(r.kind), n: num(r.n) }));
    return { total: num(row?.total), ok: num(row?.ok), failed: num(row?.failed), chars: num(row?.chars), byKind };
  }

  // FTS5 的 MATCH 语法对用户输入不友好 (裸写 - . : 会被当运算符), 这里把查询拆成
  // 词元并逐个加引号, 使其总被当作短语字面量。
  #ftsQuery(query: string): string {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    return terms.map((term) => `"${term}"`).join(" ");
  }

  searchDocuments(query: string, limit: number): { hits: DocumentHit[]; mode: "fts" | "like" } {
    if (query.trim().length === 0) {
      const rows = asRows<Record<string, unknown>>(
        this.#stmt(
          `SELECT url, kind, title, chars, bytes, fetched_at, error FROM documents
           WHERE error IS NULL ORDER BY fetched_at DESC LIMIT ?`,
        ).all(limit),
      );
      return {
        mode: this.#fts ? "fts" : "like",
        hits: rows.map((row) => ({
          url: str(row.url),
          kind: str(row.kind),
          title: str(row.title),
          chars: num(row.chars),
          bytes: num(row.bytes),
          fetchedAt: str(row.fetched_at),
          error: nullableStr(row.error),
          snippet: "",
          rank: 0,
        })),
      };
    }

    if (this.#fts) {
      const expression = this.#ftsQuery(query);
      if (expression.length > 0) {
        try {
          const rows = asRows<Record<string, unknown>>(
            this.#stmt(
              `SELECT d.url, d.kind, d.title, d.chars, d.bytes, d.fetched_at, d.error,
                      snippet(documents_fts, 1, '[', ']', ' … ', 18) AS snippet,
                      bm25(documents_fts, 6.0, 1.0) AS rank
               FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
               WHERE documents_fts MATCH ? AND d.error IS NULL
               ORDER BY rank LIMIT ?`,
            ).all(expression, limit),
          );
          return {
            mode: "fts",
            hits: rows.map((row) => ({
              url: str(row.url),
              kind: str(row.kind),
              title: str(row.title),
              chars: num(row.chars),
              bytes: num(row.bytes),
              fetchedAt: str(row.fetched_at),
              error: nullableStr(row.error),
              snippet: str(row.snippet),
              rank: Number(row.rank ?? 0),
            })),
          };
        } catch {
          // 落到 LIKE 兜底
        }
      }
    }

    const like = `%${query.toLowerCase()}%`;
    const rows = asRows<Record<string, unknown>>(
      this.#stmt(
        `SELECT url, kind, title, chars, bytes, fetched_at, error,
                substr(text, max(1, instr(lower(text), lower(?)) - 80), 240) AS snippet
         FROM documents
         WHERE error IS NULL AND (lower(title) LIKE ? OR lower(text) LIKE ?)
         ORDER BY fetched_at DESC LIMIT ?`,
      ).all(query, like, like, limit),
    );
    return {
      mode: "like",
      hits: rows.map((row) => ({
        url: str(row.url),
        kind: str(row.kind),
        title: str(row.title),
        chars: num(row.chars),
        bytes: num(row.bytes),
        fetchedAt: str(row.fetched_at),
        error: nullableStr(row.error),
        snippet: str(row.snippet),
        rank: 0,
      })),
    };
  }

  #alertRows(sql: string, args: (string | number)[]): AlertRecord[] {    const rows = asRows<Record<string, unknown>>(this.#stmt(sql).all(...args));
    return rows.map((row) => ({
      item: JSON.parse(str(row.raw)) as Item,
      rule: str(row.rule),
      matchedAt: str(row.created_at),
    }));
  }

  alertsForRun(runId: number): AlertRecord[] {
    return this.#alertRows(
      `SELECT a.item_id, a.rule, a.created_at, i.raw
       FROM alerts a JOIN instances i ON i.id = a.item_id
       WHERE a.run_id = ? ORDER BY i.published_at DESC, a.rule`,
      [runId],
    );
  }

  alerts(limit: number): AlertRecord[] {
    return this.#alertRows(
      `SELECT a.item_id, a.rule, a.created_at, i.raw
       FROM alerts a JOIN instances i ON i.id = a.item_id
       ORDER BY a.created_at DESC, a.item_id LIMIT ?`,
      [limit],
    );
  }

  searchItems(query: string, limit: number): Item[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = asRows<Record<string, unknown>>(
      this.#stmt(
        `SELECT raw FROM instances
         WHERE LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(url) LIKE ?
         ORDER BY published_at DESC LIMIT ?`,
      ).all(like, like, like, limit),
    );
    return rows.map((row) => JSON.parse(str(row.raw)) as Item);
  }

  counts(): { items: number; alerts: number; runs: number } {
    const row = asRow<Record<string, unknown>>(
      this.#stmt(
        `SELECT (SELECT COUNT(*) FROM instances) AS items,
                (SELECT COUNT(*) FROM alerts) AS alerts,
                (SELECT COUNT(*) FROM runs) AS runs`,
      ).get(),
    );
    return { items: num(row?.items), alerts: num(row?.alerts), runs: num(row?.runs) };
  }
}
