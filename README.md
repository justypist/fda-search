# fda-search — FDA 内容变更监听

针对关键词监听 FDA 官方渠道的新增/更新内容。三条采集通道, 本地 SQLite 增量比对, 命中即落盘。

结论与实测依据见 [fda-search-monitoring-research.md](./fda-search-monitoring-research.md)。

## 为什么不是爬搜索页

`fda.gov/search?s=<keyword>` 已**不可用**: 实测该路径返回 Check Point 的挑战页
(HTTP 200 但正文是 `Challenge Validation` 的验证框), 而 Search.gov 上 `affiliate=fda`
的托管结果页直接显示 **"This search page has been turned off"**。`robots.txt` 也明确
`Disallow: /search/`。Search.gov 的 Search Results API 虽有官方后端, 但其条款
禁止缓存结果, 与"监听 = 存快照做 diff"直接冲突。因此本项目改用官方推送通道 + 本地增量比对。

> 实测对照 (2026-10-16): `/search?s=listeria` → 挑战页; 普通内容页随机抽 14 个 → 全部
> HTTP 200 正常返回。**拦截只针对 `/search/`, 正文抓取不受影响。**

## 通道

| 通道 | 命令 | 覆盖 | 增量依据 | 建议频率 |
| --- | --- | --- | --- | --- |
| FDA RSS (16 个 feed) | `pnpm run collect:rss` | 新闻稿/召回/安全警报等 | 条目 `guid`/`link` 去重 + 内容指纹比对 | 15-30 分钟 |

feed 列表取自官方订阅总览页
(<https://www.fda.gov/about-fda/contact-fda/subscribe-podcasts-and-news-feeds>), 地址模板为
`<路径前缀>/<feed-id>/rss.xml`。注意该前缀目录本身返回 404, 只有子路径可用 —— 不要把它
替换成上面那个订阅页地址, 否则所有 feed 都会拼成 404。
| openFDA API (8 个数据集) | `pnpm run collect:openfda` | 召回/不良事件/510(k) 等结构化数据 | 滑动窗口 + `count` 聚合定位有数据的日期 + `meta.last_updated` 短路 | 1-6 小时 |
| sitemap `lastmod` | `pnpm run collect:sitemap` | 全站 86,699 个 URL | 索引与分页两级 `If-Modified-Since` (此处响应头稳定, 304 有效) | 1-6 小时 |
| 正文抓取 (紧跟 sitemap) | `pnpm run collect:sitemap` | 上表 URL 的正文: HTML / PDF / xlsx / docx / pptx | `ETag` / `Last-Modified` 条件请求, `documents` 表判重 | 长期后台, 每轮限量 |

### 正文通道 (全文检索)

`sitemap` 通道只给出 URL 和 `lastmod`, 没有标题和正文; 关键词只能匹配 URL 路径。打开
`content.enabled` 后, 每轮 collect 会在 sitemap 阶段之后抓一小批正文落进 `documents`
表, 并用 FTS5 建索引, 于是 `pnpm run recall <词>` 可以全文检索全站。

```bash
pnpm run collect:sitemap          # 抓一批正文 (数量由 content.batchSize 决定)
pnpm run status                   # 看"正文库: N 篇, 待抓 M 个 URL"
pnpm run recall "surrogate endpoint"
```

正文抓取也可以单独跑, 不重扫 sitemap, 只消费库里已有的 URL:

```bash
pnpm run content                    # 抓一批 (content.batchSize 篇)
pnpm run content --verbose          # 同上, 带逐篇明细与进度
pnpm run content:full --verbose     # 循环跑完所有待抓 (长期任务, 建议放 tmux)
```

> **速率与限流**: `content.concurrency` 只决定同时在飞的请求数, 平均速率由
> `content.minIntervalMs` 决定 (默认并发 4 + 每 1 秒发起一个请求, 约 1 请求/秒)。
> 实测并发 20 (约 13 请求/秒) 在 100-150 个请求后就触发 FDA 的
> `403 excessive-requests-apology`; 触发后全部工人一起暂停, 退避从
> `content.backoffMs` 起逐次翻倍, 连续 4 次仍被挡就中止本轮。被限流挡下的 URL
> **不落库**, 保持待抓状态, 下一轮自动重试。

> **必须了解的成本**: 8.6 万个 URL 中 34,595 个内容页 + 52,104 个附件。按
> 1 请求/秒计算约 24 小时; 若回到严格串行 (`concurrency: 1` + `minIntervalMs: 30000`
> 以守 `Crawl-delay: 30`), 则需要约 30 天连续运行。因此 `batchSize` 默认只有 200 ——
> 这是长期后台任务, 每轮抓一点, 若干轮之后才覆盖完。

抓取顺序按 **`lastmod` 倒序**, 已抓过的 (无论成败) 不再返回, 因此批次单调前进, 中断后
重跑会从断点继续, 不会反复卡在同一批坏 URL 上。

> **为什么是倒序**: 全量 86,699 个 URL 里绝大部分是冻结的归档 —— 实测 HTML 内容页中
> 33% 的 `lastmod` 落在 2026 年、20% 在 2024 年, 而**近 30 天真正变动过的只有 779 个**
> (平均每天 26 个)。倒序让"在变的那部分"几天内就绪, 陈年归档留到最后慢慢补,
> 而不是把 30 天平均花在一堆不会再变的历史文档上。

`content` 的字段:

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用正文抓取 |
| `batchSize` | `200` | 每轮最多抓多少篇 |
| `concurrency` | `1` | 并发工人数 (同时在飞的请求数) |
| `minIntervalMs` | `500` | 相邻请求起点的最小间隔, 决定平均速率 |
| `backoffMs` | `60000` | 被限流后的首次退避, 之后逐次翻倍, 上限 30 分钟 |
| `include` / `exclude` | 内容页目录 + `/media/` | URL 子串过滤, 直接下推到 SQL |
| `pdf` / `office` | `true` | 是否解析 PDF / Office 文档 |
| `ocr` | `true` | 是否对扫描页做 OCR |
| `ocrEngine` | `local` | `local` (PP-OCRv6, 本地) / `vision` (视觉模型) / `off` |
| `ocrMaxPages` | `8` | 单个 PDF 最多 OCR 多少页 |
| `ocrConcurrency` | `1` | 视觉模型的并发请求数上限 (仅 `vision` 引擎) |
| `maxBytes` | `64 MiB` | 单个文件上限, 超过则跳过并记为失败 |
| `maxTextChars` | `null` | 单篇正文保留的字符上限; `null` (默认) 表示不限制 |
| `match` | `false` | 正文是否参与关键词告警 (见下) |

**关于 `match`**: 默认关闭。打开后正文也会走关键词规则, 但补齐历史存量时会让大量旧页面
一次性命中 —— 监听的语义是"新出现的", 不是"库里已有的"。建议只在存量补齐完成、进入
稳定增量后再打开。

**扫描件 OCR**: PDF 用 `@firecrawl/pdf-inspector` 解析, 它会把文档分类成
`TextBased` / `Scanned` / `Mixed` / `ImageBased`, 并把原生文本转成 markdown (带标题层级与
表格)。被判为需要 OCR 的页面再转写, 有两个引擎:

| 引擎 | 依赖 | 实测速度 | 质量 |
| --- | --- | --- | --- |
| `local` (默认) | PDFium + ONNX Runtime | 2 页 2.8 秒 / 8 页 9.7 秒 | 足够; 版式固定的扫描件字段全部正确 |
| `vision` | `.env` 的 `LLM_*` | 单页 20-90 秒 | 更高, 会补全表格结构 |
| `off` | 无 | — | 扫描页留空 |

**本地引擎 + LLM 兜底**: `local` 引擎送去 OCR 却一个字符也没读出的页, 在配置了
`.env` 的 `LLM_*` 时会再交给视觉模型转写一次 —— 本地认不出不等于页面没有内容,
直接留空会让这篇文档永远检索不到。整篇没有文字 (扫描件被误判为文本型, 或全是
矢量图形) 的文档同样会走这条兜底。没有配置 `LLM_*` 时行为不变。

兜底不会浪费调用: 纯白页在做 OCR 前就被识别并跳过 (它们只会换回一句
"Empty response."), 也不计入 OCR 失败 —— 空白页本来就没有内容。

本地引擎快一到两个数量级, 且**不产生 API 费用** (纯 CPU), 因此默认用它:

```bash
pnpm run ocr:setup     # 下载 PDFium 与 ONNX Runtime 到 vendor/ocr (~30 MB)
```

模型 (~30 MB) 由库在首次 OCR 时自动下载到 `~/.cache/pdf-inspector`, 之后离线可用。
未安装运行时时扫描件会被记为"待 OCR" (`status` 显示数量) 而不是空正文, 装好后下一轮
自动重跑。

需要更高质量时切到视觉引擎:

```bash
cp .env.example .env
# 填 LLM_BASE_URL (OpenAI 兼容网关)、LLM_API_KEY、LLM_MODEL
```

然后把 `content.ocrEngine` 改成 `vision`。视觉引擎的实测特性:
单个 PDF 最多 OCR `content.ocrMaxPages` 页 (默认 8); `ocrConcurrency` 默认 1 (串行),
因为并发 2-4 时网关会明显变慢, 单页从 20-30 秒拉长到 60 秒以上, 总吞吐反而下降。
单页有 150 秒硬超时 + 一次重试, 超时用独立的 AbortController 计时器 ——
SDK 自带的 `timeout` 在流式响应上不总能生效, 实测出现过连接挂着不吐数据也不报错、
把整个抓取进程卡死的情况。

> **网关注意**: 视觉请求走**流式**接口。实测网关前置 CDN (EdgeOne) 对"响应头迟迟不来"
> 有约 10 秒的超时限制, 而非流式请求要等整页转写完成才返回响应头 (约 15-30 秒),
> 会稳定收到 `554 Response Timeout`。流式请求由模型立刻开始吐 token, 可长时间持续。
> 另外部分 One-API / New-API 系网关会把响应再包一层 `{"data": {...}}`,
> 客户端已在 fetch 层自动解包。

### openFDA 批量通道 (补历史)

openFDA 除了 API 还有官方的 **批量下载通道** `download.open.fda.gov`: 每个数据集打成一个
zip (内含一个 `.json`, 结构与 API 响应的 `{meta, results}` 完全一致), 因此字段映射直接复用
API 通道。关键区别是它**不受 `api.fda.gov` 的配额约束** (240 请求/分钟、1000 请求/天),
适合一次性补齐历史。

```bash
pnpm run bulk                                  # 按配置下几个分区
pnpm run bulk --dataset drug/enforcement       # 只下某个数据集
pnpm run bulk --limit 20                       # 一次多下几个分区
```

全部 31 个端点合计 **130.3 GB / 2,396 个分区**, 所以按 `bulk.maxPartitions` 分批下,
不要指望一轮跑完。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `datasets` | `[]` (全部已配置数据集) | 限定数据集, 形如 `drug/enforcement` |
| `maxPartitionMb` | `400` | 单个分区上限, 超过则跳过。`device/udi` 单分区可达 300 MB |
| `maxPartitions` | `4` | 单轮最多下几个分区 |

> 与 API 通道的分工: **API 走日常增量** (滑动窗口 + `meta.last_updated` 短路),
> **批量通道走一次性补历史**。两者产出同样的条目, 靠 `instances` 主键去重, 重叠安全。

### 关于并行抓取

**本项目不做代理池并行。** 理由:

1. `robots.txt` 的 `Crawl-delay: 30` 是服务器明确的速率边界, 换 IP 绕过它属于无视对方声明
2. FDA 有滥用检测 —— 实测撞到过它的 `apology_objects/abuse-detection-apology.html`,
   代理池 + 高频并行的流量特征与爬虫滥用同类, 可能连带把正常通道 (RSS / sitemap) 一起降级
3. 收益不划算: 唯一的效果是把"补陈年归档"从 30 天压到几天, 而真正在变的内容
   (每天约 26 个) 本来就只需 13 分钟/天
4. **实测硬上限**: 并发 20 (约 13 请求/秒) 在 100-150 个请求后就会收到
   `403 excessive-requests-apology`, 实际可用的速率远低于并行带来的理论收益

要提速请用上面三个正当手段: **`lastmod` 倒序** + **openFDA 批量通道** + 需要更高频率时
**填上真实联系方式正式联系 FDA 申请**。


### openFDA 通道的增量策略

openFDA 的日期字段是**报告日期**, 而记录会被持续补录到历史日期上 (实测 `drug/enforcement`
的报告日期最晚到 2026-10-07, 但当天日期已是 2026-10-16)。因此这里**不是**"推进过去就不再回看"
的严格游标, 而是每次扫描一个覆盖最近 `lookbackDays` 的**滑动重叠窗口**。重复拉到的条目由
`instances` / `alerts` 的主键去重, 不会重复告警, 所以重叠是安全的。

成本由两点控制:

1. 每轮先发 **1 次** `count=<dateField>` 聚合请求, 一次拿到窗口内"哪些天有数据"以及
   `meta.last_updated`。没有数据的日期直接跳过, 不做翻页。
2. 若 `meta.last_updated` 与上次相同且距上次扫描不足 `openfda.rescanHours` 小时, 整轮跳过
   (只花那 1 次请求)。

游标格式为 `YYYY-MM-DD:skip:windowStart`, 记录窗口扫描进度, 中途被中断可从断点续扫。
单轮请求数上限是每个数据集的 `maxRequests` (默认 20), 扫描完成前可能跨多轮进行。

## 快速开始

最快的一次完整流程 (三步):

```bash
pnpm install
pnpm run ocr:setup            # 一次性: 装本地 OCR 运行时 (~30 MB)
pnpm run collect --verbose    # 建索引 + 抓首批正文 (首轮约 45 分钟)
```

之后长期抓完剩余正文 (8.6 万个 URL, 约 2-3 天):

```bash
pnpm run content:full --verbose    # 建议放在 tmux 里, 中断后重跑会从断点继续
```

### 全部命令

日常使用:

| 命令 | 作用 |
| --- | --- |
| `pnpm run collect` | 跑全部通道 (RSS + openFDA + sitemap + 一批正文) |
| `pnpm run collect --verbose` (= `pnpm run collect:verbose`) | 同上, 输出每个通道的明细与进度 |
| `pnpm run collect:full` | 全通道 + 忽略条件请求缓存 + 解除正文批数限制 |
| `pnpm run status` | 运行历史 / 游标 / 队列 / 正文库统计 |
| `pnpm run serve` | 启动本地搜索界面 (http://127.0.0.1:8787) |
| `pnpm run search <关键词>` | 在已落库条目中检索 (标题 / 摘要 / URL) |
| `pnpm run recall <关键词>` | 在正文库中全文检索 (FTS5) |
| `pnpm run alerts` | 历史告警 |
| `pnpm run tail [n]` | 最近 n 条已落库条目 (默认 20) |

单通道 / 正文:

| 命令 | 作用 |
| --- | --- |
| `pnpm run collect:rss` | 只跑 RSS (16 个 feed) |
| `pnpm run collect:openfda` | 只跑 openFDA API (8 个数据集) |
| `pnpm run collect:sitemap` | 只跑 sitemap, 并在其后抓一批正文 |
| `pnpm run content` | 只抓一批正文, 不重扫 sitemap |
| `pnpm run content:full` | 只抓正文, 循环跑完所有待抓 |

维护:

| 命令 | 作用 |
| --- | --- |
| `pnpm run bulk` | 走 openFDA 官方批量下载通道补历史 |
| `pnpm run reset` | 清除正文库里的假失败 (403/429/超体积), 让它们重新待抓 |
| `pnpm run ocr:setup` | 安装本地 OCR 运行时 (PDFium + ONNX Runtime) |
| `pnpm test` | 单元测试 (node:test, 不联网) |
| `pnpm run typecheck` | 类型检查 |

> **不要写 `pnpm run collect -- --stage content`**: pnpm 会把 `--` 原样传进 `argv`,
> 早期版本因此静默丢弃全部开关。现已修复并在解析前剔除, 但仍建议直接用 `content` /
> `content:full` 别名, 既简短又不依赖 `--` 的传参行为。

要求 Node >= 24 (使用原生 TypeScript 类型剥离与 `node:sqlite`, 无构建步骤, 无第三方运行时框架)。
正文通道额外依赖 `@firecrawl/pdf-inspector` (PDF 分类、markdown 抽取与本地 OCR)、
`pdfjs-dist` 与 `@napi-rs/canvas` (仅 `vision` 引擎用来从扫描页取像素)、
`fflate` (Office 文档解压)。本地 OCR 另需 `pnpm run ocr:setup` 安装运行时库,
视觉引擎则需 `.env` 配置, 见下文"正文通道"。

### 本地搜索界面

`pnpm run serve` 起一个只监听 `127.0.0.1` 的小服务, 用来查"本地索引到了什么"。两种模式:

| 模式 | 索引 | 能搜到 |
| --- | --- | --- |
| 网页元数据 | `instances` 表 | 标题 / 摘要 / URL (全部通道的条目) |
| 正文全文 | `documents` 表 + FTS5 | 页面与附件的正文, 带命中高亮 |

支持 `?q=关键词` 直接带查询进来, 便于生成可复现的对比链接:

```bash
pnpm run serve --port 8788 --limit 100
open 'http://127.0.0.1:8787/?q=listeria'
```

> **关于"和官方搜索对比"**: 做不到, 因为官方站内搜索已关停 —— `fda.gov/search` 返回
> WAF 挑战页, Search.gov 的 `affiliate=fda` 结果页显示 "This search page has been turned
> off"。因此本界面只反映本地索引, 不对照官方结果。界面里也没有伪造官方结果的部分。

## 配置

`monitor.config.json`:

```jsonc
{
  "dataDir": "./data",
  "notify": ["jsonl"],          // 通知通道, 目前仅内置 jsonl
  "stages": [],                 // 留空表示全部阶段, 也可填 ["rss"] / ["content"]
  "maxWork": 2000,              // 单轮最多处理的队列条数
  "keywords": [
    {
      "name": "listeria",       // 规则名, 用于告警标记
      "any": ["listeria"],      // 命中任意一个即可 (OR)
      "all": [],                // 必须全部命中 (AND)
      "none": [],               // 命中任意一个则排除
      "regex": [],              // 正则, 全部需命中
      "caseSensitive": false,
      "sources": ["rss", "openfda", "sitemap"]  // 该规则适用于哪些通道
    }
  ],
  "sitemap": {
    "indexUrl": "https://www.fda.gov/sitemap.xml",
    "include": ["/safety/", "/news-events/"],
    "exclude": ["/media/", "/download"]
  },
  "content": {
    "enabled": false,        // 打开后每轮抓一批正文 (见"正文通道")
    "batchSize": 200,        // 每轮最多抓多少篇
    "concurrency": 1,        // 并发工人数 (同时在飞的请求数)
    "minIntervalMs": 500,    // 相邻请求起点的最小间隔, 决定平均速率
    "backoffMs": 60000,      // 被限流的首次退避, 之后逐次翻倍 (上限 30 分钟)
    "include": ["/safety/", "/media/"],
    "exclude": [],
    "pdf": true,             // 解析 PDF
    "office": true,          // 解析 xlsx / docx / pptx
    "maxBytes": 67108864,    // 单文件上限 64 MiB
    "maxTextChars": null,    // 单篇正文上限, null = 不限制 (默认)
    "match": false           // 正文是否参与关键词告警
  },
  "openfda": {
    "apiKey": "",        // 留空则读环境变量 OPENFDA_API_KEY; 免 key 配额 1000 请求/天
    "rescanHours": 12    // last_updated 未变时, 多久之内不重复扫描
  }
}
```

`openfda.datasets` 可省略 (使用内置的 8 个数据集), 也可给出以覆盖字段定义。每个数据集的
`dateField` / `dateFormat` (`compact` = `YYYYMMDD`, `dashed` = `YYYY-MM-DD`) / `idField` /
`maxRequests` 等均可在配置中改写。

匹配范围: 标题 + 摘要 + URL + 通道名 + 各通道附加字段。
`any` 为空且 `all`/`regex` 也为空时该规则不产生命中 (避免全量告警)。

## 命令与选项

```bash
node src/cli.ts <命令> [选项]

命令: collect | bulk | serve | status | alerts [n] | search <关键词> | recall <关键词> | reset | tail [n]

-c, --config <路径>   配置文件 (默认 ./monitor.config.json)
    --stage <名称>    仅跑指定阶段, 可重复: rss | openfda | sitemap | content
                      (默认 content 随 sitemap; 显式指定 content 时只抓正文, 不重扫 sitemap)
    --full            忽略条件请求缓存, 强制全量重拉; 同时解除正文的 batchSize 限制
    --max-work <n>    本轮最多处理的队列条数 (默认取配置)
    --dataset <名称>  bulk 限定数据集, 可重复 (默认取配置)
    --limit <n>       bulk 单轮最多下多少个分区 / serve 单页结果上限
    --port <n>        serve 监听端口 (默认 8787)
-v, --verbose         输出每个通道的明细
    --json            status / alerts / search / recall 输出 JSON
```

## 输出

- `data/alerts.jsonl` — 追加式告警流, 每行一条 `{run_id, rule, field, term, item, notified_at}`
- `data/runs/<时间戳>.json` — 每轮运行摘要 (各通道统计 + 本轮告警)
- `data/fda-monitor.db` — SQLite, 含条目、告警、队列、游标与正文库
- `data/collect.lock` — 单实例锁, 运行期间存在; 进程异常退出后的陈旧锁会被自动接管

## 测试

```bash
pnpm test        # 52 项, node:test, 不联网
```

- `test/units.test.ts` — 日期解析 (RFC-822 时区/紧凑与带连字符日期)、关键词规则
  (`any`/`all`/`none`/`regex`/`source` 限定/`extra` 字段)、sitemap 路径过滤与条目构造、
  正文提取 (正文区选取、导航/脚本剔除、实体解码、`ld+json` 日期、content-type 判别、
  Office 部件识别),
  以及四个已修复缺陷的回归用例 (队列键需含内容指纹、非法日期须显式报错而非产出 `NaN` 游标、
  无时区 `pubDate` 须按 UTC 解释、同一文章出现在多个 feed 时须共享主键)。
- `test/pipeline.test.ts` — 用桩 HttpClient 喂入固定样本, 覆盖采集到通知的完整链路:
  条件请求短路、条目与告警的幂等性、feed 更新后新条目恰好告警一次、`guid` 去重优先级,
  以及正文通道 (抓取落库、FTS 可检索、重复运行不重抓、过滤条件下推到 SQL)。
- `test/lock.test.ts` — 单实例锁的获取/重入拒绝/陈旧锁接管。
- 搜索界面的查询逻辑 (`buildSearch` / `buildStats`) 在 `test/units.test.ts` 内一并覆盖:
  两种模式互不串味 (只在正文里的词, 元数据模式搜不到)、空查询不返回全部、无命中返回 0。

## 架构

```
采集 (sources/*)      →  队列 (SQLite, 幂等)  →  匹配 (util/keyword)  →  落库  →  通知 (notify/*)
rss / openfda / sitemap                            条目去重 + 告警去重

sitemap 落库的 URL  →  正文抓取 (sources/content)  →  documents 表 (+ FTS5)
                       每轮限量, 不走队列
```

- **正文通道不进队列**: 它消费的是 sitemap 已经落库的 URL, 抓完直接写 `documents` 表,
  不产生新条目、不参与告警 (除非 `content.match`)。因此它有独立的进度判据 ——
  "`instances` 里有、`documents` 里没有" 即为待抓。
- **正文表与条目表分开**: `instances` 是轻量的条目元数据 (全部通道共用), `documents`
  是重字段 (正文可达百万字符)。分表后 `instances` 的查询不受大字段拖累。

- **采集与处理解耦**: 采集只负责把条目写进队列 (按 `source+channel+cursor` 唯一键去重),
  处理阶段再统一匹配落库。采集中断不会丢数据, 下一轮 `requeueStale` 会把中断任务放回待处理。
- **告警只发一次**: `alerts` 表以 `(item_id, rule)` 为主键, 条目首次入库时才产生告警,
  后续轮次即使重复采到同一条目也不会重复告警。
- **跨 feed 去重**: RSS 条目的主键是 `rss:<guid>` (回退 `link`, 最后才是标题哈希),
  **不含通道名**。FDA 会把同一篇文章同时放进多个 feed (例如一次食品召回既在 `recalls`
  也在 `food-safety-recalls`), 若把通道并入主键, 同一条内容会被当成两条独立条目而重复告警。
- **游标即队列键**: 队列唯一键是 `(source, channel, cursor)`, 其中 `cursor` 附带批次内容的
  哈希。轮询类通道可能再次算出相同的终态游标, 若只用游标做键, 内容不同的新批次会被
  静默丢弃, 因此必须把内容指纹并入键。
- **状态晚于入队提交**: `feed_state` / `cursors` / `sitemap_pages` 都在对应条目成功入队**
  之后**才写入。否则进程在两者之间中断时, 下一轮条件请求会返回 304 而跳过该窗口, 条目永久丢失。
- **队列载荷即用即弃**: 条目落库后队列行的 `payload` 会被清空, 已完成的行按
  (7 天, 保留最近 200 行) 清理。sitemap 单批载荷可达 15MB, 若永久保留数据库会无限增长。
  每轮结束执行一次 `wal_checkpoint`, 避免 WAL 长期膨胀。
- **逐通道投递**: 每个通道采集完就立刻处理队列并投递该通道新产生的告警。RSS 约 8 分钟、
  sitemap 首轮约 22 分钟, 若等到全部通道跑完再统一投递, 一次召回要在采集开始 30 分钟后
  才会被报出来。同一个 run 内每个告警只投递一次 (按 `item_id + rule` 记录已投递集合)。
- **通知可插拔**: 全部告警经 `src/notify/registry.ts` 的 `registerNotifier` 分发。新增通道
  (webhook / SMTP / Slack) 只需在 `src/notify/` 下实现并调用 `registerNotifier`, 再在
  `src/notify/index.ts` 加一行 import; `config.notify` 里写通道名即可启用。pipeline 只负责
  写运行摘要, 不再直接写告警文件。

## 合规与限速 (重要)

- 对 `fda.gov` 的 RSS / sitemap 请求按 `robots.txt` 的 `Crawl-delay: 30` **串行限速 30 秒**,
  这是这两个通道单轮耗时的主要来源: RSS 16 个 feed 约 8 分钟, sitemap 首轮 44 页约 22 分钟。
  **请勿调小 `http.fdaDelayMs`。** 首轮之后 sitemap 依靠 `If-Modified-Since` 通常只需拉 0-3 页。
- 正文通道用独立闸门 (`content.concurrency` + `content.minIntervalMs`), 不共用上面这个
  串行间隔。**实测速率边界**: 并发 20 (约 13 请求/秒) 会在 100-150 个请求后收到
  `403 excessive-requests-apology`; 默认配置 (并发 4, 每 1 秒一个请求) 远低于该阈值。
  提高速率前请自行评估, 触发限流时工具会自动退避并中止本轮。
- openFDA 走 `api.fda.gov`, 不受 crawl-delay 约束, 免 key 配额为 240 请求/分钟、1000 请求/天。
  openFDA 的日期范围**必须用 `YYYYMMDD` 或 `YYYY-MM-DD` 字面量**, 空格两边不能写成 `+`
  (实测 `[20260901+TO+20261016]` 会返回 HTTP 500)。
- 请把 `http.userAgent` 里的联系方式改成你自己的, 便于 FDA 在流量异常时联系。

## 已知限制

> 以下条目均为实现期间对真实接口实测得出, 与原调研报告有出入之处已按实测修正。

- **openFDA 日期范围的写法**: 必须用 `YYYYMMDD` 或 `YYYY-MM-DD` **字面量**, `TO` 两侧写成
  `+` 会返回 HTTP 500 (原报告的 `+` 写法有误)。本项目统一走 `URLSearchParams`, 空格编码为
  `%20` 或 `+` 均可正常工作。
- sitemap 通道只提供 URL + `lastmod`, 没有标题和正文。命中靠 URL 路径里的关键词,
  因此 `sitemap` 规则应使用路径中会出现的词 (如 `listeria`), 而不是正文词。
- sitemap 的 `lastmod` 可能只是模板/元数据变动, 会有噪音; 且 `content_type` 查询参数
  **服务端无效** (实测换任何值都返回同一份 7,421 条的警示信清单), 无法按类型过滤,
  只能拉全量再按 URL 规则过滤。
- **sitemap 有生成延迟**: 实测新页面发布约 7 小时后仍不在 sitemap 里 (sitemap 索引
  `lastmod` 是生成时刻, 页面 `datePublished` 晚于它)。因此"页面存在但 sitemap 里没有"
  属正常现象, 不代表漏收。想要零延迟只能另建推送通道。
- **正文抓取的换算成本**: 86,699 个 URL (34,595 个内容页 + 52,104 个附件)。
  按默认速率 (约 1 请求/秒) 约 24 小时; 若回退到严格串行守 `Crawl-delay: 30`,
  则需约 30 天。实测并发 20 会触发限流, 不存在"并行几分钟抓完"的选项。
- **纯图像 PDF 走 OCR**: 约 26% 的 FDA PDF (实测 79/302) 是整页扫描件,
  没有文字层。PDF 解析用 [`@firecrawl/pdf-inspector`](https://github.com/firecrawl/pdf-inspector)
  (Rust), 它先分类 (TextBased / Scanned / Mixed / ImageBased) 并把原生文本转成
  markdown; 被判为需要 OCR 的页面再由 `content.ocrEngine` 指定的引擎转写。
  默认的本地 PP-OCRv6 实测比视觉模型快 10-40 倍且无 API 费用, 质量对扫描件足够。
- **OCR 不可用时扫描件不会丢**: 完全提取不到正文的扫描件会记成一条
  `OCR 未配置` 的待办行 (不重复抓取, `status` 里显示为"待 OCR N 篇"); 运行时或
  视觉模型配好后, 下一轮抓取会自动把它们放回队列并完成 OCR。Mixed 型 PDF 若已有
  可提取文本, 照常落库, 不因缺 OCR 而丢弃那部分正文。
- **假失败可以回滚**: 被限流挡下或超过 `content.maxBytes` 的 URL 会以错误行落库,
  默认不再重试。`pnpm run reset` 会清掉 403/429/超体积这三类记录, 让它们重新待抓。
- 抓取时遇到过 **301 重定向** 的 sitemap URL (旧地址跳到新地址, 但旧地址仍在 sitemap 里)。
  代码会把重定向目标也记进 `documents` 以免重复抓, 但**两个 URL 会各留一条 sitemap 条目**,
  检索时同一内容可能出现两次。
- `datadashboard.fda.gov` **不在 sitemap 里**, openFDA 也不覆盖, 本工具目前抓不到。
- RSS 每个 feed 只保留最近约 10-20 条, 轮询间隔必须短于该窗口覆盖的时间跨度, 否则漏项。
- openFDA 各数据集本身有更新延迟 (`meta.last_updated` 实测可滞后数天), 不是实时源。
- 设备召回 (`device/recall`) 与 `device/510k` 的日期字段是 `YYYY-MM-DD`, 其余数据集是 `YYYYMMDD`,
  已在 `src/defaults.ts` 的 `dateFormat` 中区分。
- **openFDA 的 `count` 聚合无论字段格式一律返回紧凑 `YYYYMMDD`** (实测 `device/recall` 的
  `event_date_posted` 亦如此), 因此统计结果必须归一化后再做日期运算, 否则会产生 `NaN` 游标。
- openFDA 在"无匹配结果"时返回 **HTTP 404** 而非空结果集, 所有请求都需容忍 404 并解析响应体
  来区分"无数据"与"真失败"。
- RSS 的 `pubDate` 若省略时区, 按 **UTC** 解释 (不能交给 `new Date()` 用服务器本地时区,
  否则会整体偏移); 带时区缩写时按字面固定偏移换算 (EST = UTC-5, EDT = UTC-4)。
- sitemap 索引的 44 个分页中, 前约 29 页几乎全是 `/media/` 资源, 真正内容页在后半段。
  因此 `exclude: ["/media/"]` 能砍掉约 5.8 万条, 但**无法靠早停优化** (内容页分散在末段)。
- 首轮 openFDA 全量扫描 (90 天窗口 × 8 个数据集) 约需 85 次请求、数分钟; 之后靠
  `meta.last_updated` 短路, 通常每轮只需 1 次请求/数据集。

## 实现中修复的坑

以下问题均在真实接口上实测发现, 已在代码中修正并留有回归测试, 修改前请先了解原因:

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| openFDA 查询返回 HTTP 500 | `TO` 两侧写成 `+` | 统一用字面空格 (经 `URLSearchParams`) |
| 游标变成 `NaN-NaN-NaN`, 扫描卡死 | `count` 聚合对 `YYYY-MM-DD` 字段也返回紧凑 `YYYYMMDD` | `normalizeCountDay` 归一化后再运算 |
| 窗口内无数据的数据集整轮失败 | openFDA 无匹配时返回 404 而非空集 | `tolerateStatuses: [404]` + 解析响应体 |
| 进程中断后条目永久丢失 | 先写 `feed_state` 再入队, 恢复时被 304 跳过 | 状态一律在入队成功后才提交 |
| 新批次被静默丢弃 | 队列键只用游标, 重扫时与旧批次碰撞 | 键并入批次内容指纹 |
| 同一条召回重复告警 | 主键含通道名, 同一文章在多个 feed 中各算一条 | RSS 主键改为 `rss:<guid>` |
| 数据库持续膨胀 | 队列 `payload` 处理完从不清理 | 落库后清空载荷 + 定期清理旧行 |
| 告警要等 30 分钟才出 | 等全部通道跑完才统一投递 | 改为逐通道处理并投递 |
| 时间整体偏移 8 小时 | 无时区 `pubDate` 交给 `new Date()` 按本地时区解释 | 无时区时统一按 UTC |
| RSS 每轮全量重拉 | **FDA 的 `Last-Modified` 响应头不稳定**, 实测同一 feed 连续两次请求取值不同甚至倒退, 条件请求永不返回 304 | 改用**内容指纹** (条目主键序列的 hash) 判断是否变化; 响应头仅作记录 |
| 正文通道开了却一篇也抓不到 | 过滤原先在取完固定窗口后才在内存里做, 窄 `include` (如只要 `/media/`) 永远只看到列表最前面那批不匹配的 URL | 过滤条件下推到 SQL, 见 `Store.pendingDocumentUrls` |
| 正文抓取永久卡住 | 失败的 URL 不落库, 于是每一轮都重试同一批坏 URL | 失败也写一行 (带 `error`), 已抓过的无论成败都不再返回 |
| PDF 正文提取失败并刷警告 | pdfjs 在 Node 下的 legacy 构建走 `fs.readFile`, 只认文件系统路径; 传 `file://` URL 会报 `Unable to load font data` | 传目录路径 (`standardFontDataUrl` / `cMapUrl`), 用 `createRequire` 定位 |
| 正文抓取跑到几百篇就 OOM | Office 文档原先用 `unzipSync` 整块解压: 一份 57 MB 的 xlsx 内部 `sheet1.xml` 解压后 358 MB、`sharedStrings.xml` 150 MB, 连同 `strFromU8` 与多次 `replace` 的拷贝直接冲爆 4 GB 堆 | 改为 fflate 流式解压 (1 MB 分块), 边解压边剥标签; 归一化也在分块内完成, 避免对整串做多轮拷贝 (原先会把 1.59 亿字符同时拷成 4 份)。实测同一文件完整提取 1.1 亿字符, 峰值约 975 MB |
| 扫描件反复出现 "待 OCR" | 运行时可用但单页栅格化超限 (实测某页 150 DPI 需要 271 MB, 上限 256 MB) 被误判为 "OCR 未配置", 于是每轮重新下载再失败 | 区分"运行时缺失"与"单页失败": 后者先降 DPI 重试, 仍失败则照常返回原生文本并计入 OCR 失败 |
| 有内容的扫描页被静默丢弃 | 本地 OCR 读不出文字的页直接留空; 纯矢量页没有内嵌位图, 视觉模型连图都拿不到 | 本地引擎的空结果交给视觉模型兜底; 无内嵌位图时用 pdfjs 整页栅格化; 纯白页提前识别并跳过 |

> RSS 补充: 条件请求在本站基本失效, 因此每轮仍会拉取全部 16 个 feed (受 crawl-delay 约束约 8 分钟)。
> 但内容指纹让"未变化"的 feed 不入队, 配合 `guid` 主键去重, 重复拉取不会产生重复告警或重复处理。
