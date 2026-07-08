#!/usr/bin/env node

import {
  getMissingVars,
  loadLocalEnv,
  maskValue,
  optionalProviderEnv,
  requiredProviderEnv
} from "./env-utils.mjs";

const env = loadLocalEnv();
const strict = process.argv.includes("--strict");
let missingCount = 0;

console.log("Launch Club provider readiness\n");

for (const item of requiredProviderEnv) {
  const missing = getMissingVars(env, item);
  missingCount += missing.length;

  console.log(`${missing.length ? "MISSING" : "READY"} ${item.group}`);
  console.log(`  ${item.purpose}`);
  for (const key of item.vars) {
    console.log(`  ${key}=${maskValue(env[key])}`);
  }
  if (missing.length) {
    console.log(`  Need: ${missing.join(", ")}`);
  }
  console.log("");
}

console.log("Optional integrations\n");

for (const item of optionalProviderEnv) {
  const missing = getMissingVars(env, item);

  console.log(`${missing.length ? "OPTIONAL" : "READY"} ${item.group}`);
  console.log(`  ${item.purpose}`);
  for (const key of item.vars) {
    console.log(`  ${key}=${maskValue(env[key])}`);
  }
  console.log("");
}

console.log("Runtime switches");
console.log(`  REPORT_USE_MOCK_PROVIDERS=${env.REPORT_USE_MOCK_PROVIDERS ?? "unset"}`);
console.log(`  REPORT_USE_INLINE_WORKER=${env.REPORT_USE_INLINE_WORKER ?? "unset"}`);
console.log(`  REPORT_USE_MEMORY_STORE=${env.REPORT_USE_MEMORY_STORE ?? "unset"}`);
console.log(`  ENABLE_REAL_AI_CHECKS=${env.ENABLE_REAL_AI_CHECKS ?? "unset"}`);
console.log(`  ENABLE_MEME_IMAGE_GENERATION=${env.ENABLE_MEME_IMAGE_GENERATION ?? "unset"}`);

if (strict && missingCount > 0) {
  console.error(`\nMissing ${missingCount} required environment value(s).`);
  process.exit(1);
}
