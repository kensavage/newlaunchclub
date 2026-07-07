import fs from "node:fs";
import path from "node:path";

export const requiredProviderEnv = [
  {
    group: "OpenAI",
    vars: ["OPENAI_API_KEY"],
    purpose: "Business extraction and report synthesis"
  },
  {
    group: "Firecrawl",
    vars: ["FIRECRAWL_API_KEY"],
    purpose: "Website crawling, web search, and Reddit page evidence"
  },
  {
    group: "Ahrefs",
    vars: ["AHREFS_API_KEY"],
    purpose: "Traffic estimates, top pages, keyword metrics, competitors"
  },
  {
    group: "Supabase",
    vars: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    purpose: "Persistent report jobs, report results, and vendor events"
  }
];

export const optionalProviderEnv = [
  {
    group: "DataForSEO",
    vars: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    purpose: "Optional fallback for Google Ads keyword volume and Google SERP research"
  },
  {
    group: "Reddit API",
    vars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"],
    purpose: "Optional richer Reddit OAuth data; Firecrawl search is used without these"
  },
  {
    group: "Memes.ai",
    vars: ["MEMES_AI_API_URL", "MEMES_AI_API_KEY"],
    purpose: "Optional generated meme image URLs for report creative concepts"
  },
  {
    group: "Launch Club",
    vars: ["NEXT_PUBLIC_BOOK_CALL_URL"],
    purpose: "Pricing table and final booking CTA"
  }
];

export function loadLocalEnv(cwd = process.cwd()) {
  const env = { ...process.env };

  for (const file of [".env", ".env.local"]) {
    const filePath = path.join(cwd, file);
    if (!fs.existsSync(filePath)) continue;

    const parsed = parseEnvFile(fs.readFileSync(filePath, "utf8"));
    Object.assign(env, parsed);
  }

  return env;
}

export function parseEnvFile(contents) {
  const result = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();

    result[key] = unquote(rawValue);
  }

  return result;
}

export function getMissingVars(env, item) {
  return item.vars.filter((key) => !env[key]);
}

export function maskValue(value) {
  if (!value) return "missing";
  if (value.length <= 8) return "set";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function isTruthyEnv(value) {
  return value === "true" || value === "1" || value === "yes";
}

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
