import { expect, test } from "@playwright/test";

test("visitor submits a URL and work email and receives a secure opportunity report", async ({
  page
}) => {
  await page.goto("/");

  await page.getByLabel("Website URL").fill("launchclub.ai");
  await page.locator("#work-email").fill("owner@launchclub.ai");
  await page.getByRole("button", { name: /run report/i }).click();

  await expect(
    page.getByRole("heading", { name: /Your AI Search & Reddit Opportunity Report/i })
  ).toBeVisible({
    timeout: 20_000
  });
  await expect(page).toHaveURL(/\/reports\/lc_report_[A-Za-z0-9_-]{43}$/);
  const reportApiResponsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/reports/lc_report_") && response.status() === 200
  );
  const reportPageResponse = await page.reload();
  const reportApiResponse = await reportApiResponsePromise;
  expect(reportApiResponse.headers()["cache-control"]).toContain("no-store");
  expect(reportPageResponse?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(reportPageResponse?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByText("Your Hidden Keyword Goldmine")).toBeVisible();
  await expect(page.getByText("The Reddit Conversations You're Missing")).toBeVisible();
  await expect(page.getByText("How to read this report")).toBeVisible();
  await expect(page.getByText("What the Research Measured")).toBeVisible();
  await expect(page.getByText("Where Competitors Have Source Coverage")).toBeVisible();
  await expect(page.getByText("AI Search Opportunity Simulations")).toBeVisible();
  await expect(page.getByText("Your Ready-to-Review Comment Scripts")).toBeVisible();
  await expect(page.getByText("Not measured").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Post This Comment/i }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Book a Call to Discuss Full Service/i })).toBeVisible();
  await expect(page.getByText("Video Testimonials")).toHaveCount(0);
  await expect(page.getByText("4x-9x")).toHaveCount(0);
  await expect(page.getByText(/300 posts\/mentions/i)).toHaveCount(0);
  await expect(page.getByText(/90-Day Opportunity/i)).toHaveCount(0);

  await page.getByRole("button", { name: /Post This Comment/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByText("Nothing is posted automatically.")).toBeVisible();
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
