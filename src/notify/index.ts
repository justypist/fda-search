// 内置通知通道。新增通道时在此加一行 import, 并在 src/notify/ 下实现该通道。
import "./jsonl.ts";

export { registerNotifier, notifierNames, dispatch, type Notifier } from "./registry.ts";
