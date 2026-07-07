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
  await expect(page.getByText("How Much Traffic Is Waiting for You")).toBeVisible();
  await expect(page.getByText("Where Your Competitors Are Already Winning")).toBeVisible();
  await expect(page.getByText("Video Testimonials")).toBeVisible();
  await expect(page.getByText("The AI Search Multiplier Effect")).toBeVisible();
  await expect(page.getByText("Your Ready-to-Use Comment Scripts")).toBeVisible();
  await expect(page.getByRole("button", { name: /Post This Comment/i }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Book a Call to Discuss Full Service/i })).toBeVisible();

  await page.getByRole("button", { name: /Post This Comment/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});
