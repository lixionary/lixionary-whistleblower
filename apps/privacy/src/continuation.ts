import { continuationCodeSchema } from "@whistle/shared";
import { digest, mac } from "@whistle/runtime";
import type { Config } from "./config.js";

export function continuationHash(config: Config, code: string) {
  const canonical = continuationCodeSchema.parse(code);
  // Keyed hashes protect short credentials against offline guessing from a DB copy.
  return canonical.length === 9
    ? mac(config.abuseKey, `intake-code:${canonical}`)
    : digest(canonical);
}
