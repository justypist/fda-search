# FDA 搜索列表变更监听 —— 技术调研报告

> 调研对象：https://www.fda.gov/search?s=<keyword>
> 目标：针对特定关键词，监听该搜索结果列表的变化
> 报告日期：2026-10-16
> 所有结论均附带实测证据（见附录 A 复现命令）

---

## 0. 给开发者的 TL;DR

1. **FDA 官网没有自己的搜索 API。** 站内搜索是采购的第三方服务 **Search.gov（美国 GSA）**，后台是 Search.gov 的 Search Results API。
2. **直接爬 `/search?s=keyword` 在当前网络环境下不可行**：会被 **Check Point 的机器人挑战页**拦截（HTTP 200 但正文是验证页，而非搜索结果）。robots.txt 也 `Disallow: /search/`。
3. **Search.gov API 理论上可用，但对"监听"这个用途有硬性合规障碍**：其服务条款明确 **"Customers using our Search Results API cannot cache results"（不得缓存结果）**，而监听本质上需要保存上一次结果并 diff。因此**不推荐**把它作为主方案。
4. **推荐方案：改用 FDA 官方数据推送通道 + 本地增量比对**，优先级如下：
   - **P0：FDA 官方 RSS 订阅源（16 个）** —— 覆盖新闻稿、召回、安全警报、药品/生物制品更新等，天然只含"新"内容，无需 diff 搜索引擎。
   - **P0：openFDA API** —— 结构化数据集，支持关键词检索、日期范围、排序、增量拉取，免费额度充足。
   - **P1：fda.gov sitemap.xml 的 `lastmod` 差分** —— 可覆盖 RSS 未覆盖的任意页面，作为兜底。
   - **P2：官方邮件订阅（GovDelivery）** —— 无需自建，但不是程序化接口。
5. **务必注意**：sitemap 的 `content_type` 参数**是无效的**（实测不同取值返回完全相同的数据），不要被它误导。

---

## 1. 目标页面技术分析

### 1.1 搜索参数

| 请求 | HTTP | 实际内容 |
|---|---|---|
| `/search?s=test` | 200 | **1526 字节，Check Point "Challenge Validation" 挑战页** |
| `/search?q=test` | 200 | 30533 字节，Drupal 外壳页，**但无服务端渲染结果** |
| `/search` | 200 | 30533 字节，同上 |
| `/search/test` | 404 | Page Not Found |

**结论：**

- 站内搜索的真实参数是 **`s`**（见下方表单 markup），也就是你需要监听的那个 URL。
- **`?s=` 会被 WAF 拦截**，而 `?q=` 不会——但这不代表 `?q=` 能用：它返回的页面里 **`views-row` 计数为 0**，正文只有 "No results" 占位，说明结果**不是服务端渲染**的。
- 换言之，**在数据中心 IP / 无浏览器环境下，服务端拿不到搜索结果 DOM**。

### 1.2 页面结构证据

搜索表单（来自 `https://www.fda.gov/search`）：

```html
<form action="/search" method="get" id="views-exposed-form-search-page-1">
<input ... name="s" data-autocomplete-path="/suggestion/autocomplete" />
```

- 站点是 **Drupal**（`/core/...`、`simple_sitemap`、`views-exposed-form` 均为 Drupal 特征）。
- 自动补全走 `/suggestion/autocomplete`，**不是**结果接口。
- **Drupal JSON:API 未启用**：`/jsonapi` 与 `/jsonapi/node/press_release` 均返回 404。

### 1.3 robots.txt 约束

```text
#Search.gov
User-agent: usasearch
Crawl-delay: 2

User-agent: *
Crawl-Delay: 30
Disallow: /search/
```

- `usasearch` 这个 UA 的存在，**直接证明 FDA 的站内搜索由 Search.gov 提供**。
- 普通爬虫被要求 **30 秒 crawl-delay**，且 **`Disallow: /search/`**。

### 1.4 拦截细节

`?s=` 返回的挑战页特征：

```html
<title>Challenge Validation</title>
<script src="/bWJQMo2gJl1r/fWTIdu5KrR/..."></script>
<iframe ... provider="adaptive" challenge="eyJ0b2tlbiI6...">
```

- 供应商为 **Check Point**（`cp_clge_done`、`sec-cpt-if`、`provider="adaptive"`）。
- 换用浏览器 UA **无效**，仍是同样的 1526 字节挑战页。
- 这意味着：即使加了 UA 伪装，也需要 **JS challenge 求解 / 真实浏览器（headless）** 才可能通过，从而实现成本与稳定性都很差，且违反 robots。

---

## 2. 方案一：Search.gov API（FDA 搜索的真实后端）

### 2.1 端点

两个等价入口（实测均返回结构化 JSON 错误信息，说明端点是活的）：

```text
https://search.usa.gov/api/v2/search/i14y?affiliate=<affiliate>&query=<term>&access_key=<key>
https://api.gsa.gov/technology/searchgov/v2/results/i14y?affiliate=<affiliate>&query=<term>&access_key=<key>
```

实测错误语义：

```json
// 缺 access_key
{"errors":["access_key must be present"]}
// 缺 affiliate
{"errors":["affiliate must be present"]}
// 用 DEMO_KEY + affiliate=fda
{"errors":["affiliate not found"]}
```

**注意**：`affiliate=fda` 配 `DEMO_KEY` 返回 "affiliate not found"，即 **FDA 这个 affiliate 无法用公共 demo key 访问**，必须由持有权限的账号签发 key。通过 `access_key=demo`、`affiliate=usagov` 等尝试均失败。

### 2.2 获取方式

- Search.gov 已迁移：`search.gov/developer/` 现 301 跳转到 **https://digital.gov/guides/search**
- 申请入口：**https://search.usa.gov/signup**（登录 **https://search.usa.gov/login**；两者对无头请求返回 403，属正常）
- 官方对 API 的定位（引自 https://digital.gov/guides/search/set-up ）：
  > "If you don't want to use the hosted search results page, you can use the APIs... **Search results API**: Use the search results API to receive web results, best bets, news, and videos in **one JSON call**."

### 2.3 ⚠️ 关键合规障碍（决定是否采用）

引自 Search.gov 服务条款（https://digital.gov/guides/search/about ）：

| 条款 | 原文要点 | 对"监听"的影响 |
|---|---|---|
| **Secondary use** | "Customers using our **Search Results API cannot cache results**" | **监听必须保存上次结果做 diff，与"不得缓存"直接冲突** |
| **Citing data** | "must display **'Powered by SearchGov'** using plain text for attribution" | 后台服务也需满足署名要求 |
| **Right to limit** | "Use of the APIs may be subject to certain limitations on access, calls, or use"；越限可能被**永久封禁** | 定时轮询有风险 |
| 适用对象 | 面向 **Search.gov 的 active customer**（通常是该机构自己或其授权方） | FDA 第三方开发者未必有资格 |

**结论：** Search.gov API 是"官方后端"，但它是**给 FDA 自己集成用的**，并非面向第三方做数据监听；条款已明确禁止缓存结果。**不建议作为监听的主方案**，除非能与 FDA/GSA 明确获得授权与例外。

---

## 3. 方案二：FDA 官方 RSS 订阅源【推荐】

FDA 在 `/about-fda/contact-fda/subscribe-podcasts-and-news-feeds` 页面公布了 RSS 列表。**全部 16 个实测 HTTP 200**：

| feed id | 名称 | items | RSS title |
|---|---|---|---|
| `press-releases` | Press Releases | 20 | FDA Press Releases RSS Feed |
| `recalls` | Recalls / Safety Alerts | 20 | Food and Drugs Administration--Recalls/Safety Alerts |
| `medwatch` | MedWatch Safety Alerts | 20 | MedWatch Safety Alerts RSS Feed |
| `consumers` | Consumer Health Information Updates | 20 | Consumer Updates RSS Feed |
| `drugs` | What's New: Drugs | 20 | What's New: Drugs RSS Feed |
| `biologics` | Vaccines / Blood / Biologics | 20 | Whats New Vaccines Blood Biologics RSS Feed |
| `food-safety-recalls` | Food Safety Recalls | 20 | FDA Food Safety Recalls RSS Feed |
| `fda-outbreaks` | FDA Outbreaks | 20 | FDA Outbreaks RSS Feed |
| `food-allergies` | Food Allergies | 20 | Food Allergies |
| `health-fraud` | Health Fraud | 10 | Health Fraud RSS Feed |
| `tainted-dietary-supplements` | Tainted Dietary Supplements | 20 | Tainted Dietary Supplements |
| `oci-press-releases` | OCI Press Releases | 20 | Office of Criminal Investigations (OCI) Press Releases RSS Feed |
| `ora-foia-electronic-reading-room` | ORA FOIA Reading Room | 20 | ORA FOIA Electronic Reading Room RSS Feed |
| `disco` | D.I.S.C.O. (Oncology) | 1 | FDA Drug Information Soundcast in Clinical Oncology |
| `drug-safety-podcast` | Drug Safety Podcasts | 2 | FDA Drug Safety Podcasts |
| `rss-podcast-QA-FDA` | Q&A with FDA | 2 | Q&A with FDA |

URL 规则：`https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/<feed-id>/rss.xml`

### 3.1 条目结构（实测样例）

```xml
<item>
  <title>Family Farmstead Dairy Announces Recall of Raw Mild Cheddar Cheese ...</title>
  <link>http://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/...</link>
  <description>The U.S. Food and Drug Administration ...</description>
  <pubDate>Thu, 15 Oct 2026 16:04:00 EDT</pubDate>
  <dc:creator>FDA</dc:creator>
  <guid isPermaLink="true">http://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/...</guid>
</item>
```

- **去重主键**：优先 `guid`，回退 `link`。
- 时间字段为 **RFC-822**（如 `Thu, 15 Oct 2026 16:04:00 EDT`），注意时区为美东（EDT/EST）。
- 每个 feed 只保留最近约 10–20 条，**窗口有限**（`recalls` 实测最旧条目为 `01 Oct 2026`）。轮询间隔需小于窗口跨度。

### 3.2 优缺点

- ✅ FDA 自己维护的官方推送通道，格式稳定，天然"增量"。
- ✅ 无需 diff 搜索引擎，合规风险低（仍应遵守 crawl-delay）。
- ❌ **只覆盖 FDA 主动纳入 feed 的主题**，不等于全站搜索。
- ❌ 部分 feed 更新稀疏（disco/drug-safety-podcast/qa-fda 仅 1–2 条）。
- ❌ 条目窗口有限，低频轮询可能漏项。

---

## 4. 方案三：openFDA API【推荐（结构化数据）】

### 4.1 端点与实测总量

基址 `https://api.fda.gov/<dataset>.json`。实测（2026-10-16）：

| dataset | 实测 total | 内容 |
|---|---:|---|
| `drug/event` | 20,692,690 | 药品不良事件 |
| `device/event` | 26,557,775 | 器械不良事件 |
| `drug/enforcement` | 18,010 | 药品召回 |
| `device/enforcement` | 40,249 | 器械召回 |
| `food/enforcement` | 29,485 | 食品召回 |
| `device/recall` | 59,494 | 器械召回（另一数据集） |
| `device/510k` | 176,366 | 器械 510(k) |
| `drug/label` | 262,897 | 药品说明书 |
| `drug/ndc` | 138,450 | NDC 目录 |
| `food/event` | 151,589 | 食品不良事件 |
| `animalandveterinary/event` | 1,378,854 | 兽药/动物 |
| `tobacco/problem` | 1,383 | 烟草问题 |

> 注意：`drug/enforcement` 实测总数 18,010 **小于** sitemap 中 warning letter 的数量级，两者集合不同，不可混用。

### 4.2 查询能力（全部实测通过）

```text
# 关键词（全文/字段）
GET /drug/enforcement.json?search=reason_for_recall:"sterility"&limit=1
→ "total": 6282

# 日期范围：必须用 YYYYMMDD，且空格需编码为 + 或使用 --data-urlencode
GET /drug/enforcement.json?search=report_date:[20260101+TO+20261016]&limit=1
→ "total": 638

# 排序
GET /drug/enforcement.json?sort=report_date:desc&limit=2

# 聚合计数（可用于发现增量）
GET /drug/enforcement.json?count=report_date
→ {"time":"20120620","count":14} ...

# 分页
GET ...?limit=100&skip=24900   # skip 上限 25000，超过返回错误
```

- **关键坑**：日期范围里 **`YYYY-MM-DD` 形式会报错**（实测返回 `"error"`）；必须用 **`YYYYMMDD`**，且 `TO` 两侧的空格需 URL 编码为 `+`。
- `sort` 字段为 **`YYYYMMDD` 字符串**（如 `"report_date":"20261007"`）。
- `skip` **必须 ≤ 25000**（实测 `skip=25000` 返回 `NOT_FOUND`，更大报 "Skip value must 25000 or less"）。深翻页需改用日期游标。
- 响应含 **`meta.last_updated`**（实测 `"2026-10-07"`），可用于判断数据集是否更新。

### 4.3 配额（来自官方文档页）

| 认证方式 | 速率 | 日上限 |
|---|---|---|
| 无 key（按 IP） | 240 请求/分钟 | **1,000 请求/天** |
| 带 API key | 240 请求/分钟 | **120,000 请求/天** |

- 免 key 即可用，但 **1,000/天** 对高频轮询偏紧；生产环境建议申请 key。
- 官方认证说明：https://open.fda.gov/apis/authentication/

### 4.4 优缺点

- ✅ 结构化、字段干净、支持关键词/日期/排序，天然适合增量同步。
- ✅ 有 `meta.last_updated` 与 `count` 聚合，便于判断变化。
- ✅ 免 key 可试用。
- ❌ 只覆盖 FDA 开放数据集的领域，**不等于 fda.gov 全站内容**（例如指导文件、部分公告可能不在其中）。
- ❌ 数据集本身有更新延迟（`last_updated` 可能滞后数天）。

---

## 5. 方案四：sitemap.xml `lastmod` 差分【兜底，覆盖全站】

### 5.1 实测规模

- 索引：`https://www.fda.gov/sitemap.xml` → **44 个分页**。
- 每页 **2000 条**，最后一页 699 条 → **全站约 86,699 个 URL**。
- **`<lastmod>` 覆盖率极高**：page1 的 2000 条中有 **1999 条**带 `lastmod`。
- 最新 `lastmod` 实测可到当天（如 `2026-10-15T08:16:49-04:00`），说明**新发布/修改的页面会及时反映**。

### 5.2 ⚠️ 重大陷阱：`content_type` 参数无效

索引页里存在形如 `https://www.fda.gov/fda_sitemaps.xml?content_type=warning_letter` 的链接，**看起来**可以按类型过滤。但实测：

| 请求 | 前 3 条 URL |
|---|---|
| `?content_type=warning_letter` | warning-letters/tofu-yu-llc-... |
| `?content_type=press_release` | **完全相同** |
| `?content_type=recalls` | **完全相同** |
| 无参数 | **完全相同** |

- 三者输出 `cmp` 结果为 **identical**，且与不带参数时一致。
- **结论：`content_type` 只是 sitemap 里残留的自动生成链接，服务端并未实际过滤。** 开发时**不要依赖它**，必须拉全量再自行按 URL 规则分类。

### 5.3 增量做法

1. 首次全量拉取 44 页，建立 URL → lastmod 的基线（约 8.7 万条，建议入库）。
2. 之后按固定频率重拉，比较 `lastmod` 大于上次记录的条目。
3. 只有 `lastmod` 变新或出现新 URL 时，才判定为新增/更新。
4. 建议逐页对比并设置**早停**：若某页无任何新 `lastmod`，可停止后续分页。
5. 全量 44 页、每页约 280KB，**全量单轮约 12MB**；务必控制频率（遵守 30s crawl-delay 的精神），建议 ≥ 30 分钟一轮，并做本地缓存。

### 5.4 优缺点

- ✅ **唯一能覆盖"任意新页面"的通用兜底**，不依赖 FDA 是否提供 feed。
- ✅ `lastmod` 覆盖率高、时效性好。
- ❌ 数据量大（8.7 万 URL），需要存储做基线。
- ❌ `lastmod` **不等于内容实质变更**（可能只是模板/元数据改动），会有噪音。
- ❌ 只有 URL 列表，无标题/正文，需再抓取页面详情才能按关键词匹配（增加请求量）。
- ❌ `content_type` 不可用，无法在服务端按类型缩减。

---

## 6. 方案五：其他可选通道

### 6.1 官方邮件订阅（GovDelivery）

- FDA 使用 **GovDelivery**：`https://public.govdelivery.com/accounts/USFDA/subscriber/new` （实测 200）。
- 属 FDA 官方推送，可按主题订阅；但**不是程序化 API**，只适合人工接收或邮箱解析。

### 6.2 第三方网页变更监控工具

| 工具 | 地址 | 实测 | 说明 |
|---|---|---|---|
| changedetection.io | https://github.com/dgtlmoon/changedetection.io | 200 | 开源自托管，支持 CSS 选择器、浏览器渲染、通知 |
| Visualping | https://www.visualping.io | 200 | 商业 SaaS，可视化选择区域 |
| RSS.app | https://rss.app | 200 | 把任意页面转 RSS |

- 优点：**零开发**，支持 JS 渲染（可绕部分反爬）。
- ❌ **对 `/search?s=` 仍会撞上 Check Point 挑战页**，需要这些工具具备真实浏览器 + 反检测能力，稳定性不可保证，且同样违反 robots 的 `Disallow: /search/`。
- 建议：若要免开发，**指向 RSS feed 或 sitemap**，而不是搜索页。

---

## 7. 方案对比总表

| 方案 | 官方性 | 覆盖范围 | 增量友好 | 合规风险 | 实现成本 | 推荐度 |
|---|---|---|---|---|---|---|
| 爬 `/search?s=` | 官方页面 | 全站搜索命中 | 差（需 diff DOM） | **高**（WAF + robots 禁止） | 高（需破 JS 挑战） | ❌ 不推荐 |
| Search.gov API | 官方后端 | 全站搜索命中 | 中（需自存快照） | **高（条款禁止缓存）** | 中（需申请 key） | ⚠️ 需授权 |
| **FDA RSS（16 个）** | **官方** | 主要主题 | **好** | 低 | **低** | ✅ **P0** |
| **openFDA API** | **官方** | 开放数据集 | **好** | 低 | **低** | ✅ **P0** |
| **sitemap lastmod** | **官方** | **全站（兜底）** | 中（需基线库） | 低 | 中 | ✅ **P1** |
| GovDelivery 邮件 | 官方 | 订阅主题 | 差（人工） | 低 | 低 | P2 |
| 第三方监控 SaaS | 第三方 | 取决于配置 | 中 | 对 search 页高 | 极低 | P2 |

---

## 8. 给开发团队的落地建议

### 8.1 推荐架构（分层）

```text
┌─ 采集层 ────────────────────────────────────────────┐
│  A. FDA RSS 轮询（每 15–30 分钟）                    │
│  B. openFDA 增量查询（按 report_date 游标）           │
│  C. sitemap lastmod 全量差分（每 1–6 小时）           │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ 归一化层 ──────────────────────────────────────────┐
│  统一结构：{id, source, title, summary, url, date}   │
│  id 优先级：guid > link > openFDA 主键 > url          │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ 匹配层 ────────────────────────────────────────────┐
│  关键词匹配：标题 + 摘要 + URL                        │
│  支持 any / all / 正则；建议忽略大小写                │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ 去重/存储 ─────────────────────────────────────────┤
│  已见 id 集合（DB / Redis / 文件），落库并按时间裁剪   │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌─ 通知层 ────────────────────────────────────────────┐
│  Slack / 飞书 / 企业微信 / 邮件 / Webhook            │
└─────────────────────────────────────────────────────┘
```

### 8.2 关键实现要点（避坑清单）

1. **不要** 依赖 `content_type` 过滤 sitemap，服务端无效。
2. **不要** 用 `YYYY-MM-DD` 写 openFDA 日期范围，必须 `YYYYMMDD`；`TO` 的空格用 `+` 或 URL 编码。
3. openFDA `skip` 上限 **25000**，深翻页改用**日期游标**（记录上次最大 `report_date`，下次 `search=report_date:[<last>+TO+<now>]`）。
4. RSS 的 `pubDate` 是 **RFC-822 + 美东时区**，入库前统一转 UTC，避免时区错位。
5. RSS 条目窗口仅 `10–20 条，**轮询间隔必须短于窗口覆盖的时间跨度**，否则漏项；同时用 `guid` 去重。
6. sitemap 全量约 **8.7 万 URL / 约 12MB**，首轮建基线后**逐页早停**，避免每轮全量拉取。
7. **限速**：遵守 robots.txt 的 `Crawl-delay: 30`，对 fda.gov 的请求建议串行 + 间隔；openFDA 注意 1,000/天（免 key）与 240/分钟。
8. 若确需 Search.gov API：**先取得授权并书面确认缓存例外**，否则不要在生产中缓存其结果。

### 8.3 建议的轮询频率

| 通道 | 建议频率 | 理由 |
|---|---|---|
| FDA RSS | 15–30 分钟 | 窗口有限，需及时捕获 |
| openFDA | 1–6 小时 | 数据集本身更新有延迟 |
| sitemap | 1–6 小时 | 全量较大，需控制压力 |
| GovDelivery | — | 邮件到达即处理 |

---

## 9. 尚未验证 / 需业务确认的问题

1. **Search.gov 是否对第三方开放 FDA 的 `affiliate=fda` key**？需向 FDA/GSA 确认授权与缓存条款例外。
2. FDA 是否还有其他未公开的 feed 或数据接口（本次仅验证了公开页面列出的 16 个）。
3. openFDA 各数据集的实际更新延迟（`last_updated` 实测滞后数天，需按数据集分别评估）。
4. sitemap 的 `lastmod` 是否包含"内容实质变更"还是仅"元数据变更"（需抽样比对页面正文）。
5. 是否需要覆盖**西语页面**（recalls feed 中已出现西语条目，属重复内容，去重策略需考虑）。

---

## 附录 A：复现命令（供开发验证）

```bash
# 1) 搜索页被 WAF 拦截
curl -s -o /tmp/a -w "HTTP %{http_code} bytes=%{size_download}\\n" \\
  -A "Mozilla/5.0" "https://www.fda.gov/search?s=test"
grep -o "<title>[^<]*</title>" /tmp/a          # → Challenge Validation

# 2) robots.txt 证据
curl -s "https://www.fda.gov/robots.txt"

# 3) Search.gov API 存活
curl -s "https://search.usa.gov/api/v2/search/i14y?affiliate=fda&query=test"
# → {"errors":["access_key must be present"]}

# 4) 列举 FDA RSS
curl -sL -A "Mozilla/5.0" \\
  "https://www.fda.gov/about-fda/contact-fda/subscribe-podcasts-and-news-feeds" \\
  | grep -oE 'href="[^"]*rss-feeds[^"]*rss\\.xml"'

# 5) openFDA 关键词 + 日期范围
curl -sG "https://api.fda.gov/drug/enforcement.json" \\
  --data-urlencode 'search=reason_for_recall:"sterility"' --data-urlencode 'limit=1'
curl -sG "https://api.fda.gov/drug/enforcement.json" \\
  --data-urlencode 'search=report_date:[20260101+TO+20261016]' --data-urlencode 'limit=1'

# 6) sitemap 规模与 lastmod 覆盖率
curl -s "https://www.fda.gov/sitemap.xml" | grep -c "<loc>"        # → 44
curl -s "https://www.fda.gov/sitemap.xml?page=1" | grep -c "<lastmod>"  # → 1999

# 7) content_type 无效验证（两次输出应完全相同）
curl -s "https://www.fda.gov/fda_sitemaps.xml?content_type=warning_letter" | grep -o "<loc>[^<]*</loc>" | head -3
curl -s "https://www.fda.gov/fda_sitemaps.xml?content_type=press_release" | grep -o "<loc>[^<]*</loc>" | head -3
```

## 附录 B：参考链接

- FDA 站内搜索：https://www.fda.gov/search
- FDA RSS 订阅总览：https://www.fda.gov/about-fda/contact-fda/subscribe-podcasts-and-news-feeds
- FDA robots.txt：https://www.fda.gov/robots.txt
- FDA sitemap：https://www.fda.gov/sitemap.xml
- openFDA API 文档：https://open.fda.gov/apis/
- openFDA 认证与配额：https://open.fda.gov/apis/authentication/
- Search.gov 指南（原 developer 站）：https://digital.gov/guides/search
- Search.gov API 说明：https://digital.gov/guides/search/set-up
- Search.gov 条款（禁止缓存）：https://digital.gov/guides/search/about
- Search.gov 注册：https://search.usa.gov/signup
- FDA 邮件订阅（GovDelivery）：https://public.govdelivery.com/accounts/USFDA/subscriber/new
- changedetection.io：https://github.com/dgtlmoon/changedetection.io
