import { appendJsonl } from "../util/text.ts";
import { join } from "node:path";
import { registerNotifier, type NotifyContext } from "./registry.ts";

registerNotifier({
  name: "jsonl",
  send: async ({ config, runId, alerts }: NotifyContext): Promise<void> => {
    if (alerts.length === 0) return;
    appendJsonl(
      join(config.dataDir, "alerts.jsonl"),
      alerts.flatMap((alert) =>
        alert.matches.map((match) => ({
          run_id: runId,
          rule: alert.rule,
          field: match.field,
          term: match.term,
          item: alert.item,
          notified_at: new Date().toISOString(),
        })),
      ),
    );
  },
});
