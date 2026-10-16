import type { Alert } from "../pipeline.ts";
import type { Config } from "../types.ts";

export interface NotifyContext {
  config: Config;
  runId: number;
  alerts: Alert[];
}

export interface Notifier {
  name: string;
  send: (context: NotifyContext) => Promise<void>;
}

// 通知通道注册表。单独成模块以避免 index.ts <-> 各通道文件之间的循环导入。
const registry = new Map<string, Notifier>();

export const registerNotifier = (notifier: Notifier): void => {
  registry.set(notifier.name, notifier);
};

export const notifierNames = (): string[] => [...registry.keys()].sort();

export const dispatch = async (context: NotifyContext): Promise<string[]> => {
  const delivered: string[] = [];
  for (const name of context.config.notify) {
    const notifier = registry.get(name);
    if (notifier === undefined) continue;
    await notifier.send(context);
    delivered.push(name);
  }
  return delivered;
};
