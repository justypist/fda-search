// pnpm 会把 `pnpm run collect -- --stage content` 中的 `--` 原样传进 process.argv。
// parseArgs 把 `--` 视为"其后全部是位置参数", 于是所有开关被静默丢弃:
// stages 变成空数组, 含义从"只抓正文"翻转成"跑全部通道", 对 fda.gov 意味着
// 多出 20 多分钟的 sitemap 请求。因此解析前先去掉这个分隔符。
export const stripSeparators = (argv: string[]): string[] => argv.filter((arg: string): boolean => arg !== "--");

// 兜底: 若仍有选项没被识别而落进位置参数, 宁可报错也不要让 stages 空转。
export const strayFlags = (positionals: string[]): string[] =>
  positionals.filter((arg: string): boolean => arg.startsWith("-"));
