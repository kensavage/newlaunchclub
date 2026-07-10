import { expect, test } from "@playwright/test";

const internalRoutes = [
  "/pricing",
  "/about",
  "/contact",
  "/watch-demo",
  "/blog",
  "/reddit-scraper",
  "/intel",
  "/case-studies",
  "/terms_and_privacy"
] as const;

test("all footer destinations render without horizontal overflow", async ({ page }) => {
  for (const route of internalRoutes) {
    const response = await page.goto(route);
    expect(response?.ok(), `${route} should respond successfully`).toBeTruthy();
    await expect(page.locator("body")).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth
    }));
    expect(widths.document, `${route} should fit the viewport`).toBeLessThanOrEqual(widths.viewport);
  }
});

test("the shared footer points to the rebuilt local routes", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator(".legacy-home-footer");
  await expect(footer).toBeVisible();
  await expect(footer.locator('a[href="/pricing"]')).toHaveText("Pricing");
  await expect(footer.locator('a[href="/about"]')).toHaveText("About");
  await expect(footer.locator('a[href="/contact"]')).toHaveText("Contact");
  await expect(footer.locator('a[href="/watch-demo"]')).toHaveText("Watch a Demo");
  await expect(footer.locator('a[href="/blog"]')).toHaveText("Reddit Secrets");
  await expect(footer.locator('a[href="/reddit-scraper"]')).toHaveText("Reddit Scraper");
  await expect(footer.locator('a[href="/intel"]')).toHaveText("Reddit Intelligence Report");
  await expect(footer.locator('a[href="/case-studies"]')).toHaveText(
    "Reddit Marketing Case Studies"
  );
});

test("access, checkout, and booking controls preserve their live destinations", async ({ page }) => {
  await page.goto("/pricing");

  await page.getByRole("button", { name: "Access LaunchClub" }).click();
  await expect(page.getByRole("link", { name: "Launch Club Client" })).toHaveAttribute(
    "href",
    "https://launchclub.ai/client"
  );
  await expect(page.getByRole("link", { name: "Launch Club Agency" })).toHaveAttribute(
    "href",
    "https://launchclub.ai/agency"
  );
  await page.getByRole("button", { name: "Access LaunchClub" }).click();

  await page.getByRole("button", { name: "Get Started" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to secure checkout" })).toHaveAttribute(
    "href",
    "https://launchclub.ai/pricing"
  );
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Book A Call" }).click();
  await expect(page.locator(".booking-dialog iframe")).toHaveAttribute(
    "src",
    /app\.cal\.com\/launchclubai\/discovery-call/
  );
});

test("case study tabs and downloads work", async ({ page }) => {
  await page.goto("/case-studies");
  await expect(page.locator(".case-card")).toHaveCount(4);
  await page.getByRole("tab", { name: "Agency" }).click();
  await expect(page.locator(".case-card")).toHaveCount(5);
  await expect(page.getByRole("link", { name: "Download PDF" }).first()).toHaveAttribute(
    "href",
    /docs\.google\.com\/document\/export/
  );
});

test("demo, contact, scraper, and blog integrations stay connected", async ({ page }) => {
  await page.goto("/watch-demo");
  await expect(page.locator(".demo-video-wrap iframe")).toHaveAttribute(
    "src",
    "https://www.loom.com/embed/e8653cae40054a40b7b6767f9546a644"
  );

  await page.goto("/contact");
  const contactForm = page.locator('form[name="launchclub-contact"]');
  await expect(contactForm).toHaveAttribute("method", "POST");
  await expect(contactForm).toHaveAttribute("data-netlify", "true");
  await expect(contactForm).toHaveAttribute("enctype", "multipart/form-data");

  await page.goto("/reddit-scraper");
  await expect(page.locator(".scraper-download").first()).toHaveAttribute(
    "href",
    /docs\.google\.com\/spreadsheets/
  );

  await page.goto("/blog");
  const firstArticle = page.locator(".blog-card h2 a").first();
  await expect(firstArticle).toHaveAttribute("href", /^\/blog\//);
  await firstArticle.click();
  await expect(page.locator(".blog-article h1")).toBeVisible();
  await expect(page.locator(".wordpress-content")).toBeVisible();
});

test("internal pages remain contained on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of internalRoutes) {
    await page.goto(route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, `${route} should not overflow at 390px`).toBeLessThanOrEqual(0);
  }
});
