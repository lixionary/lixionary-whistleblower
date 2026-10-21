import { test, expect, type Page } from "@playwright/test";
import { selectLanguage } from "./language";

async function mockStaff(page: Page) {
  await page.route("**/api/staff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/staff/login/options"
          ? { googleEnabled: true }
          : path === "/api/staff/me"
            ? {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                name: "Synthetic staff",
                email: "synthetic@example.test",
                role: "analyst",
                mfaEnrolled: true,
                mfaVerified: true,
              }
            : [],
    });
  });
}

for (const path of ["/staff/login", "/staff/account"]) {
  test(`${path}: selection updates translations and persists across reload`, async ({
    page,
  }) => {
    await mockStaff(page);
    await page.goto(path);
    const selector = page.getByRole("combobox", { name: "Language" });
    await expect(selector).toHaveText("Bahasa Indonesia");
    await expect(selector.locator("img")).toHaveAttribute(
      "src",
      "/flags/id.svg",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await selector.click();
    await expect(
      page.getByRole("option", { name: "Bahasa Indonesia", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("option", { name: "English" }).click();
    await expect(selector).toHaveText("English");
    await expect(selector.locator("img")).toHaveAttribute(
      "src",
      "/flags/gb.svg",
    );
    await expect(selector).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wb_language")))
      .toBe("en");
    await page.reload();
    await expect(selector).toHaveText("English");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await selectLanguage(page, "id");
    if (path === "/staff/login") {
      await expect(
        page.getByLabel("Kata sandi", { exact: true }),
      ).toBeVisible();
    }
    await selectLanguage(page, "en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test(`${path}: keyboard selection and dismissal retain normal focus navigation`, async ({
    page,
  }) => {
    await mockStaff(page);
    await page.goto(path);
    const selector = page.getByRole("combobox", { name: "Language" });
    await selector.focus();
    await selector.press("Enter");
    await expect(selector).toHaveAttribute("aria-expanded", "true");
    await expect(selector).toBeFocused();
    await selector.press("End");
    const indonesian = page.getByRole("option", { name: "Bahasa Indonesia" });
    await expect(selector).toHaveAttribute(
      "aria-activedescendant",
      (await indonesian.getAttribute("id"))!,
    );
    await selector.press("Enter");
    await expect(selector).toHaveText("Bahasa Indonesia");
    await expect(selector).toBeFocused();
    await selector.press("Space");
    await selector.press("Home");
    await selector.press("ArrowUp");
    await expect(selector).toHaveAttribute(
      "aria-activedescendant",
      (await indonesian.getAttribute("id"))!,
    );
    await selector.press("ArrowDown");
    await selector.press("Space");
    await expect(selector).toHaveText("English");
    await selector.press("ArrowDown");
    await selector.press("ArrowDown");
    await selector.press("Escape");
    await expect(selector).toHaveAttribute("aria-expanded", "false");
    await expect(selector).toHaveText("English");
    await expect(selector).toBeFocused();
    await selector.click();
    await selector.press("Tab");
    await expect(selector).not.toBeFocused();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await selector.click();
    await page.getByRole("contentinfo").click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test(`${path}: dropdown stays within a narrow viewport`, async ({ page }) => {
    await mockStaff(page);
    await page.goto(path);
    for (const width of [320, 393, 600]) {
      await page.setViewportSize({ width, height: 740 });
      for (const language of ["id", "en"] as const) {
        await selectLanguage(page, language);
        await page.getByRole("combobox", { name: "Language" }).click();
        const box = (await page.getByRole("listbox").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(740);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        if (width === 320 && language === "id")
          await page.screenshot({
            path: test.info().outputPath("narrow-dropdown.png"),
          });
        await page.getByRole("combobox", { name: "Language" }).press("Escape");
      }
    }
  });
}

test("Google button renders its local brand icon with both translated labels", async ({
  page,
}) => {
  await mockStaff(page);
  await page.goto("/staff/login");
  for (const language of ["en", "id"] as const) {
    await selectLanguage(page, language);
    const button = page.getByRole("button", {
      name: language === "en" ? "Sign in with Google" : "Masuk dengan Google",
      exact: true,
    });
    await expect(button).toBeEnabled();
    await expect(button).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const icon = button.locator("img");
    await expect(icon).toHaveAttribute("alt", "");
    await expect(icon).toHaveAttribute("src", "/google-g.png");
    await expect
      .poll(() =>
        icon.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.getByRole("combobox", { name: "Language" }).click();
    await page.screenshot({
      path: test.info().outputPath(`login-${language}.png`),
      fullPage: true,
    });
    await page.getByRole("combobox", { name: "Language" }).press("Escape");
  }
});
