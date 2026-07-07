#!/usr/bin/env node

import {
  isTruthyEnv,
  loadLocalEnv,
  maskValue
} from "./env-utils.mjs";

const env = loadLocalEnv();
const spendCredits = process.argv.includes("--spend-credits") || isTruthyEnv(env.SMOKE_SPEND_CREDITS);
const checkOptional = process.argv.includes("--include-optional") || isTruthyEnv(env.SMOKE_INCLUDE_OPTIONAL);
const results = [];

await checkOpenAI();
await checkFirecrawl();
await checkAhrefs();
await checkSupabase();
if (checkOptional) {
  await checkDataForSEO();
  await checkReddit();
}
await checkMemesAi();

console.log("\nProvider smoke test summary\n");
for (const result of results) {
  console.log(`${result.status} ${result.name}: ${result.detail}`);
}

if (results.some((result) => result.status === "FAIL")) {
  process.exit(1);
}

async function checkOpenAI() {
  if (!env.OPENAI_API_KEY) return skip("OpenAI", "OPENAI_API_KEY is missing.");

  try {
    const json = await requestJson("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      }
    });
    pass("OpenAI", `authenticated; ${Array.isArray(json.data) ? json.data.length : "unknown"} models visible.`);
  } catch (error) {
    fail("OpenAI", error);
  }
}

async function checkFirecrawl() {
  if (!env.FIRECRAWL_API_KEY) return skip("Firecrawl", "FIRECRAWL_API_KEY is missing.");
  if (!spendCredits) {
    return skip(
      "Firecrawl",
      `key present (${maskValue(env.FIRECRAWL_API_KEY)}); live scrape skipped. Add --spend-credits to test.`
    );
  }

  try {
    const json = await requestJson("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: "https://example.com",
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 86400000
      })
    });
    pass("Firecrawl", `scraped example.com; returned text=${Boolean(json.data?.markdown)}.`);
  } catch (error) {
    fail("Firecrawl", error);
  }
}

async function checkDataForSEO() {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    return skip("DataForSEO", "DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD is missing.");
  }

  try {
    const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
    await requestJson("https://api.dataforseo.com/v3/appendix/user_data", {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });
    pass("DataForSEO", "authenticated with free appendix/user_data endpoint.");
  } catch (error) {
    fail("DataForSEO", error);
  }
}

async function checkAhrefs() {
  if (!env.AHREFS_API_KEY) return skip("Ahrefs", "AHREFS_API_KEY is missing.");

  try {
    await requestJson("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", {
      headers: {
        Authorization: `Bearer ${env.AHREFS_API_KEY}`,
        Accept: "application/json"
      }
    });
    pass("Ahrefs", "authenticated with free limits-and-usage endpoint.");
  } catch (error) {
    fail("Ahrefs", error);
  }
}

async function checkReddit() {
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET || !env.REDDIT_USER_AGENT) {
    return skip("Reddit", "REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, or REDDIT_USER_AGENT is missing.");
  }

  try {
    const auth = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString("base64");
    const json = await requestJson("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": env.REDDIT_USER_AGENT
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString()
    });
    pass("Reddit", `OAuth token received; expires in ${json.expires_in ?? "unknown"} seconds.`);
  } catch (error) {
    fail("Reddit", error);
  }
}

async function checkSupabase() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return skip("Supabase", "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
  }

  try {
    const url = new URL("/rest/v1/report_jobs", env.SUPABASE_URL);
    url.searchParams.set("select", "public_id");
    url.searchParams.set("limit", "1");
    await requestJson(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    pass("Supabase", "service key can read report_jobs table.");
  } catch (error) {
    fail("Supabase", error);
  }
}

async function checkMemesAi() {
  if (!env.MEMES_AI_API_URL || !env.MEMES_AI_API_KEY) {
    return skip("Memes.ai", "optional MEMES_AI_API_URL or MEMES_AI_API_KEY is missing.");
  }

  skip(
    "Memes.ai",
    "credentials present, but live image generation smoke test is disabled until provider docs are confirmed."
  );
}

async function requestJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${safeMessage(json)}`);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function safeMessage(json) {
  if (json?.error?.message) return String(json.error.message).slice(0, 220);
  if (json?.error) return String(json.error).slice(0, 220);
  if (json?.message) return String(json.message).slice(0, 220);
  return "provider request failed";
}

function pass(name, detail) {
  results.push({ name, status: "PASS", detail });
}

function skip(name, detail) {
  results.push({ name, status: "SKIP", detail });
}

function fail(name, error) {
  results.push({
    name,
    status: "FAIL",
    detail: error instanceof Error ? error.message : "unknown error"
  });
}
