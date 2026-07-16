import { parseServerEnv, type ServerEnv } from "../../src/lib/env-schema";

export type { ServerEnv } from "../../src/lib/env-schema";

export function getNetlifyRuntimeEnv(): ServerEnv {
  return parseServerEnv(process.env);
}
