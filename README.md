# Launch Club AI Search Opportunity Report

Public Launch Club lead magnet for generating an AI Search Opportunity Report from a submitted website URL.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The app can run locally with `REPORT_USE_MOCK_PROVIDERS=true`, `REPORT_USE_INLINE_WORKER=true`,
and `REPORT_USE_MEMORY_STORE=true`.
Production should configure real provider credentials, Supabase, and Netlify background functions.

Set `NEXT_PUBLIC_BOOK_CALL_URL` to the call-booking page you want the report pricing table and final CTA to use.

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Provider readiness without spending credits:

```bash
npm run env:check
npm run smoke:providers
```

`smoke:providers` checks free/auth-only endpoints where available: OpenAI models, DataForSEO
`appendix/user_data`, Ahrefs `subscription-info/limits-and-usage`, Reddit OAuth, and Supabase
table access. Firecrawl live scraping is skipped by default because it can consume credits:

```bash
npm run smoke:providers:credits
```

## Going Live

1. Copy `.env.example` to `.env.local`.
2. Fill in provider keys and `NEXT_PUBLIC_BOOK_CALL_URL`.
3. Run `npm run env:check`.
4. Run `npm run smoke:providers`.
5. Run `npm run smoke:providers:credits` when you are ready to spend a small Firecrawl scrape.
6. Set `REPORT_USE_MOCK_PROVIDERS=false`.
7. For Netlify, set `REPORT_USE_INLINE_WORKER=false` and put the same secrets in Netlify
   Project configuration > Environment variables.

Optional meme image generation is disabled until a real Memes.ai endpoint is confirmed. When ready,
set `MEMES_AI_API_URL`, `MEMES_AI_API_KEY`, and `ENABLE_MEME_IMAGE_GENERATION=true`.

## Main Routes

- `/` URL-only homepage report generator.
- `/reports/[publicId]` shareable browser-rendered report.
- `/api/reports` create a report job.
- `/api/reports/[publicId]` poll report status/result.

## Report Sections

- Business profile, keyword opportunities, and search-volume prioritization.
- Reddit opportunities with source links, safe post/comment angles, and directional traffic/engagement proxies.
- Competitor and source visibility gaps.
- Remotion-powered visibility transformation graphic.
- Four AI-search prompt/Q&A examples, labeled as simulations unless real checks are enabled.
- Memes.ai-ready meme concepts for creative follow-up.
- Pricing table and book-call CTA shown after the value sections.

## Provider Docs

- Netlify Background Functions: https://docs.netlify.com/build/functions/background-functions/
- DataForSEO: https://docs.dataforseo.com/v3/
- Ahrefs API: https://docs.ahrefs.com/en/api/docs/introduction
- Firecrawl: https://docs.firecrawl.dev/mcp-server
- Reddit Data API: https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- OpenAI Models: https://developers.openai.com/api/docs/models
- Remotion existing app install: https://www.remotion.dev/docs/brownfield
- Netlify environment variables: https://docs.netlify.com/build/environment-variables/get-started/
