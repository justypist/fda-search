import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

// 纯图像 PDF 的兜底: 先把页面里的整页位图转成 JPEG, 再交给视觉模型转写文字。
// 走 OpenAI 兼容接口 (自建网关), 配置全部来自环境变量 (.env):
//   LLM_BASE_URL  网关地址, 形如 https://gateway.example.com/v1
//   LLM_API_KEY   网关密钥
//   LLM_MODEL     支持图像输入的模型名
// 三者缺一即视为未配置, OCR 自动关闭。

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  // 同时在跑的视觉请求数上限。一页扫描件要 20-30 秒, 放任所有抓取工人
  // 一起发请求会把网关打满, 也会让单次延迟更长。
  concurrency: number;
}

export interface VisionClient {
  model: string;
  transcribe(images: Uint8Array[]): Promise<string>;
}

const PROMPT = [
  "You are transcribing a scanned document published by the U.S. Food and Drug Administration.",
  "Transcribe every visible character exactly as printed, preserving reading order, headings,",
  "tables and line breaks. Do not summarize, translate or add commentary.",
  "If the page contains no legible text, return an empty response.",
].join(" ");

export const visionConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  concurrency = 1,
): VisionConfig | null => {
  const baseUrl = env.LLM_BASE_URL?.trim() ?? "";
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() ?? "";
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) return null;
  return { baseUrl, apiKey, model, concurrency: Math.max(1, Math.floor(concurrency)) };
};

// 自建网关 (One-API / New-API 系) 会把 OpenAI 响应再包一层 {"data": {...}},
// 标准 SDK 解析不了 ("Invalid JSON response")。这里在 fetch 层解包:
// 只改成功的 JSON 响应, 原样保留状态码与其余头。
// 流式响应 (SSE) 不在此列 —— 它本来就是逐行的, 不能整块解析。
const unwrapEnvelope = async (response: Response): Promise<Response> => {
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("application/json")) return response;
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  if (typeof parsed !== "object" || parsed === null) {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const inner = record["data"];
  if (keys.length !== 1 || typeof inner !== "object" || inner === null) {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  return new Response(JSON.stringify(inner), { status: response.status, headers: response.headers });
};

const gatewayFetch: typeof fetch = async (input, init) => unwrapEnvelope(await fetch(input, init));

// 简单的计数信号量: 控制同时在跑的视觉请求数。
class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free <= 0) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#free -= 1;
    try {
      return await task();
    } finally {
      this.#free += 1;
      this.#queue.shift()?.();
    }
  }
}

export const createVisionClient = (config: VisionConfig): VisionClient => {
  const provider = createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, name: "llm", fetch: gatewayFetch });
  const model = provider.chat(config.model);
  const limit = new Semaphore(config.concurrency);

  // 必须用流式: 网关前面挂着 EdgeOne, 它对"响应头迟迟不来"有超时限制 (实测约 10 秒)。
  // 一页扫描件转写通常要 15-30 秒, 非流式请求会稳定收到 554 / "Response Timeout by EdgeOne",
  // 而流式请求由模型立刻开始吐 token, 响应头马上返回, 整个流可以持续很久。
  //
  // 硬看门狗: SDK 的 timeout 在流式响应上不总是生效 —— 实测出现过连接一直挂着、
  // 既不吐数据也不报错的情况, 于是整个抓取进程卡死。这里用 AbortController 加一个
  // 独立计时器, 到点无条件中止并让调用方拿到异常, 保证工人一定会被释放。
  const PAGE_DEADLINE_MS = 150_000;

  const attempt = async (images: Uint8Array[]): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_DEADLINE_MS);
    try {
      const result = streamText({
        model,
        temperature: 0,
        maxOutputTokens: 8_000,
        maxRetries: 0,
        abortSignal: controller.signal,
        timeout: PAGE_DEADLINE_MS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              ...images.map((data) => ({ type: "file" as const, mediaType: "image/jpeg", data })),
            ],
          },
        ],
      });
      const text = await result.text;
      // 流正常结束但没有内容, 视同失败 (交给重试), 否则会静默丢掉一页。
      if (text.trim().length === 0) throw new Error("empty transcription");
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  };

  // 单页失败重试一次。超时、554 与 "No output generated" 都是网关侧的瞬时问题;
  // 重试放在这里而不是 SDK 的 maxRetries, 是为了让退避受信号量约束 (不会放大并发)。
  const transcribe = async (images: Uint8Array[]): Promise<string> =>
    limit.run(async () => {
      try {
        return await attempt(images);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return attempt(images);
      }
    });

  return {
    model: config.model,
    transcribe,
  };
};

export const createVisionFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  concurrency = 1,
): VisionClient | null => {
  const config = visionConfigFromEnv(env, concurrency);
  return config === null ? null : createVisionClient(config);
};
