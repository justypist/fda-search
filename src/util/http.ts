import type { HttpConfig } from "../types.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpRequest {
  url: string;
  scope?: string;
  minDelayMs?: number;
  headers?: Record<string, string>;
  conditional?: { lastModified: string | null };
  // 这些状态码不视为错误, 而是连响应体一起正常返回。openFDA 对"无匹配结果"
  // 返回 HTTP 404 + JSON 错误体, 调用方需要读取该响应体来区分"无数据"与"真失败"。
  tolerateStatuses?: number[];
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Headers;
  notModified: boolean;
}

export interface BinaryResponse {
  status: number;
  bytes: Uint8Array;
  headers: Headers;
  notModified: boolean;
  finalUrl: string;
}

// 流式响应: 调用方拿 body 自己去 pipe, 不必先落进内存。
// openFDA 的批量分区可达 275 MB (解压后 1.4 GB), 整块缓存是浪费。
export interface StreamResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
}

export class HttpError extends Error {
  readonly status: number;
  readonly scope: string;
  // 仅 403/429 时保留响应体开头: FDA 的限流页会指向 excessive-requests-apology,
  // 调用方据此区分"被限流"与"该 URL 本来就不允许访问"。
  readonly body: string;
  // Retry-After 换算成毫秒; 服务器没给则为 0, 由调用方决定退避策略。
  readonly retryAfterMs: number;

  constructor(message: string, status: number, scope: string, body: string = "", retryAfterMs: number = 0) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.scope = scope;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

const retryAfterMsOf = (headers: Headers): number => {
  const seconds = Number(headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(headers.get("retry-after") ?? "");
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  readonly #config: HttpConfig;
  readonly #scopes = new Map<string, number>();

  constructor(config: HttpConfig) {
    this.#config = config;
  }

  async #throttle(scope: string, minDelayMs: number): Promise<void> {
    const last = this.#scopes.get(scope);
    if (last !== undefined) {
      const elapsed = Date.now() - last;
      if (elapsed < minDelayMs) await sleep(minDelayMs - elapsed);
    }
    this.#scopes.set(scope, Date.now());
  }

  async fetchText(request: HttpRequest): Promise<HttpResponse> {
    const scope = request.scope ?? new URL(request.url).host;
    const minDelayMs = request.minDelayMs ?? (scope.endsWith("fda.gov") ? this.#config.fdaDelayMs : this.#config.minDelayMs);
    const headers: Record<string, string> = {
      "user-agent": this.#config.userAgent,
      accept: "application/json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
      ...request.headers,
    };
    if (request.conditional?.lastModified !== null && request.conditional?.lastModified !== undefined) {
      headers["if-modified-since"] = request.conditional.lastModified;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.#config.retries; attempt += 1) {
      await this.#throttle(scope, minDelayMs);
      try {
        const response = await fetch(request.url, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(this.#config.timeoutMs),
        });
        if (response.status === 304) {
          return { status: 304, body: "", headers: response.headers, notModified: true };
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.#config.retries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5_000;
          await response.body?.cancel();
          await sleep(Math.min(backoff, 120_000));
          lastError = new HttpError(`${request.url} 返回 ${response.status}`, response.status, scope);
          continue;
        }
        if (!response.ok && !(request.tolerateStatuses ?? []).includes(response.status)) {
          await response.body?.cancel();
          throw new HttpError(`${request.url} 返回 HTTP ${response.status}`, response.status, scope);
        }
        const body = await this.#readCapped(response);
        return { status: response.status, body, headers: response.headers, notModified: false };
      } catch (error) {
        if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
        lastError = error as Error;
        if (attempt < this.#config.retries) {
          await sleep(Math.min(2 ** attempt * 5_000, 120_000));
          continue;
        }
      }
    }
    throw lastError ?? new Error(`${request.url} 请求失败`);
  }

  async #readCapped(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#config.maxBytes) {
      await response.body?.cancel();
      throw new HttpError(`响应体 ${declared} 字节超过上限 ${this.#config.maxBytes}`, 0, "size");
    }
    const body = await response.text();
    if (body.length > this.#config.maxBytes) {
      throw new HttpError(`响应体 ${body.length} 字节超过上限 ${this.#config.maxBytes}`, 0, "size");
    }
    return body;
  }

  async fetchJson<T>(request: HttpRequest): Promise<T> {
    const response = await this.fetchText(request);
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new HttpError(`${request.url} 返回的内容不是合法 JSON`, 0, request.scope ?? "json");
    }
  }

  // 正文通道要拉 PDF / Office 文档, 必须走字节流而不是 text():
  // 一是 text() 会按 UTF-8 解码破坏二进制, 二是文档体积普遍大于 text 接口的
  // maxBytes 上限。这里单独设更高的字节上限, 并记录重定向后的最终 URL ——
  // 站点内存在 301 (sitemap 里的旧 URL 会跳到新 URL), 需要用它做去重。
  async fetchBytes(request: HttpRequest & { maxBytes?: number }): Promise<BinaryResponse> {
    const scope = request.scope ?? new URL(request.url).host;
    const minDelayMs = request.minDelayMs ?? (scope.endsWith("fda.gov") ? this.#config.fdaDelayMs : this.#config.minDelayMs);
    const limit = request.maxBytes ?? this.#config.maxBytes;
    const headers: Record<string, string> = {
      "user-agent": this.#config.userAgent,
      accept: request.headers?.["accept"] ?? "*/*",
      "accept-language": "en-US,en;q=0.9",
      ...request.headers,
    };
    if (request.conditional?.lastModified !== null && request.conditional?.lastModified !== undefined) {
      headers["if-modified-since"] = request.conditional.lastModified;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.#config.retries; attempt += 1) {
      await this.#throttle(scope, minDelayMs);
      try {
        const response = await fetch(request.url, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(this.#config.timeoutMs),
        });
        if (response.status === 304) {
          return { status: 304, bytes: new Uint8Array(0), headers: response.headers, notModified: true, finalUrl: response.url };
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.#config.retries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5_000;
          await response.body?.cancel();
          await sleep(Math.min(backoff, 120_000));
          lastError = new HttpError(`${request.url} 返回 ${response.status}`, response.status, scope);
          continue;
        }
        if (!response.ok && !(request.tolerateStatuses ?? []).includes(response.status)) {
          await response.body?.cancel();
          throw new HttpError(`${request.url} 返回 HTTP ${response.status}`, response.status, scope);
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > limit) {
          await response.body?.cancel();
          throw new HttpError(`${request.url} 体积 ${declared} 字节超过上限 ${limit}`, 0, "size");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) {
          throw new HttpError(`${request.url} 体积 ${bytes.byteLength} 字节超过上限 ${limit}`, 0, "size");
        }
        return { status: response.status, bytes, headers: response.headers, notModified: false, finalUrl: response.url || request.url };
      } catch (error) {
        if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
        lastError = error as Error;
        if (attempt < this.#config.retries) {
          await sleep(Math.min(2 ** attempt * 5_000, 120_000));
          continue;
        }
      }
    }
    throw lastError ?? new Error(`${request.url} 请求失败`);
  }

  // 流式下载: 不把响应体收进内存, 直接交出 body 供调用方 pipe。
  // 用于 openFDA 批量分区这类大文件 (最大 275 MB, 解压后 1.4 GB)。
  //
  // 超时用 request.timeoutMs 而非配置里的默认值: 配置的 30 秒是按小文本请求设的,
  // 对流式大文件是整个下载过程的墙钟上限, 275 MB 需要一分多钟, 30 秒必然中断。
  // 不做重试 —— body 一旦开始消费就无法重放, 重试交由调用方负责。
  async fetchStream(request: HttpRequest & { timeoutMs?: number }): Promise<StreamResponse> {
    const scope = request.scope ?? new URL(request.url).host;
    const minDelayMs = request.minDelayMs ?? (scope.endsWith("fda.gov") ? this.#config.fdaDelayMs : this.#config.minDelayMs);
    await this.#throttle(scope, minDelayMs);
    const response = await fetch(request.url, {
      headers: {
        "user-agent": this.#config.userAgent,
        accept: "*/*",
        ...request.headers,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(request.timeoutMs ?? this.#config.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(`${request.url} 返回 HTTP ${response.status}`, response.status, scope);
    }
    return { status: response.status, body: response.body, headers: response.headers };
  }

  // 无节流的字节抓取, 供并发工人使用。
  //
  // 存在的理由: #throttle 是按 scope 串行的 —— 并发调用 fetchBytes 只会被它排成一队,
  // 拿不到任何并行度。并发由调用方统一控制 (固定的 N 个工人), 因此这里不再节流,
  // 也不重试 (重试会放大并发数, 让实际速率不可控)。
  //
  // 注意: 这会突破 robots.txt 的 Crawl-Delay 声明, 仅在调用方明确选择并发时使用。
  async fetchBytesDirect(request: HttpRequest & { maxBytes?: number; timeoutMs?: number }): Promise<BinaryResponse> {
    const limit = request.maxBytes ?? this.#config.maxBytes;
    const headers: Record<string, string> = {
      "user-agent": this.#config.userAgent,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      ...request.headers,
    };
    if (request.conditional?.lastModified) headers["if-modified-since"] = request.conditional.lastModified;

    const response = await fetch(request.url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(request.timeoutMs ?? this.#config.timeoutMs),
    });
    if (response.status === 304) {
      return { status: 304, bytes: new Uint8Array(0), headers: response.headers, notModified: true, finalUrl: response.url };
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        const body = await response.text().catch(() => "");
        throw new HttpError(
          `${request.url} 返回 HTTP ${response.status}`,
          response.status,
          "fda.gov",
          body.slice(0, 512),
          retryAfterMsOf(response.headers),
        );
      }
      await response.body?.cancel();
      throw new HttpError(`${request.url} 返回 HTTP ${response.status}`, response.status, "fda.gov");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw new HttpError(`${request.url} 体积 ${declared} 字节超过上限 ${limit}`, 0, "size");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new HttpError(`${request.url} 体积 ${bytes.byteLength} 字节超过上限 ${limit}`, 0, "size");
    }
    return { status: response.status, bytes, headers: response.headers, notModified: false, finalUrl: response.url || request.url };
  }
}
