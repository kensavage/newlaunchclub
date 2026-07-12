import { expect, test } from "@playwright/test";

test("visitor submits only a URL and receives a rendered opportunity report", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Website URL").fill("launchclub.ai");
  await page.getByRole("button", { name: /run report/i }).click();

  await expect(
    page.getByRole("heading", { name: /Your AI Search & Reddit Opportunity Report/i })
  ).toBeVisible({
    timeout: 20_000
  });
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
