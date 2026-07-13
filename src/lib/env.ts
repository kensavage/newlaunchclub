import "server-only";
import {
  hasSupabaseEnv as hasSupabaseEnvironment,
  parseServerEnv,
  shouldUseMockProviders as shouldUseMockProviderEnvironment,
  type ServerEnv
} from "@/lib/env-schema";

export type { ServerEnv } from "@/lib/env-schema";

export function getServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}

export function hasSupabaseEnv(env = getServerEnv()) {
  return hasSupabaseEnvironment(env);
}

export function shouldUseMockProviders(env = getServerEnv()) {
  return shouldUseMockProviderEnvironment(env);
}
