import { expect, test } from "@playwright/test";

test("visitor submits a URL and sees truthful stage-based preparation progress", async ({
  page
}) => {
  await page.goto("/");

  await page.getByLabel("Website URL").fill("launchclub.ai");
  await page.locator("#work-email").fill("owner@launchclub.ai");
  await page.getByRole("button", { name: /run report/i }).click();

  await expect(page.getByText("Preparing research").first()).toBeVisible({
    timeout: 20_000
  });
  await expect(page).toHaveURL(/\/$/);
  const progressPanel = page.locator(".progress-panel");
  await expect(progressPanel).toContainText("Request received");
  await expect(progressPanel).toContainText("Preparing research");
  await expect(progressPanel).not.toContainText(/\d+%/);
  await expect(progressPanel).not.toContainText(/Researching visibility|Analyzing findings|Building report|Quality review|Report ready/i);
  await expect(progressPanel).not.toContainText(/ready_for_provider_research|research_ready/i);
  await expect(page.getByText(/Firecrawl|Ahrefs|OpenAI|Reddit API/i)).toHaveCount(0);
});

test("the existing homepage form placements remain usable on desktop and mobile", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#website-url")).toBeVisible();
  await expect(page.locator("#work-email")).toBeVisible();
  await expect(page.locator("#footer-website-url")).toBeVisible();
  await expect(page.locator("#footer-work-email")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const urlBox = await page.locator("#website-url").boundingBox();
  const emailBox = await page.locator("#work-email").boundingBox();
  const buttonBox = await page.getByRole("button", { name: /run report/i }).boundingBox();
  expect(urlBox).not.toBeNull();
  expect(emailBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(emailBox!.y).toBeGreaterThanOrEqual(urlBox!.y + urlBox!.height);
  expect(buttonBox!.y).toBeGreaterThanOrEqual(emailBox!.y + emailBox!.height);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
