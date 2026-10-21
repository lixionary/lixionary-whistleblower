import { selectLanguage } from "./language";
import { test, expect, type Page } from "@playwright/test";
import { generateSecret, generateURI } from "otplib";

async function mockGoogle(
  page: Page,
  { enabled = true, enrolled = true, failure = "", expired = false } = {},
) {
  let returnPath = "/staff";
  let mfa = false,
    startRequests = 0,
    enrollRequests = 0,
    meRequests = 0;
  const secret = generateSecret(),
    uri = generateURI({ issuer: "Speak Up", label: "staff@gmail.com", secret });
  await page.route("https://accounts.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    // Real cross-site navigation and redirects exercise the browser's SameSite cookie policy.
    const callback = new URL(
      "/api/staff/google/callback",
      url.searchParams.get("redirect_uri")!,
    );
    callback.searchParams.set("state", "synthetic-state");
    await route.fulfill({
      contentType: "text/html",
      body: `<html><body><script>location.replace(${JSON.stringify(callback.href)})</script></body></html>`,
    });
  });
  await page.route("**/api/staff/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const headers = await request.allHeaders();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, json: data });
    if (path === "/api/staff/login/options")
      return json({ googleEnabled: enabled });
    if (path === "/api/staff/google/start") {
      startRequests++;
      expect(request.method()).toBe("POST");
      expect(headers["x-csrf"]).toBe("1");
      const next = request.postDataJSON().next;
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set(
        "redirect_uri",
        new URL("/api/staff/google/callback", request.url()).href,
      );
      url.searchParams.set("next", next);
      returnPath = next;
      return route.fulfill({
        json: { authorizationUrl: url.href },
        headers: {
          "set-cookie":
            "wb_staff_google=browser-proof; Path=/api/staff/google; HttpOnly; SameSite=Lax",
        },
      });
    }
    if (path === "/api/staff/google/callback") {
      expect(headers.cookie).toContain("wb_staff_google=browser-proof");
      const next = returnPath;
      return route.fulfill({
        status: 302,
        headers: {
          location: `/staff/login?${failure ? "googleError=" + failure : "google=continue"}&next=${encodeURIComponent(next ?? "/staff")}`,
          ...(failure || expired
            ? {}
            : {
                "set-cookie":
                  "wb_staff=pre-mfa; Path=/; HttpOnly; SameSite=Strict",
              }),
        },
      });
    }
    if (path === "/api/staff/me") {
      meRequests++;
      if (expired || !headers.cookie?.includes("wb_staff="))
        return json({ error: "unauthorized" }, 401);
      return json({
        id: "b3818026-60d7-4e21-aa20-eaf86f181cca",
        email: "staff@gmail.com",
        name: "Google staff",
        role: "analyst",
        mfaEnrolled: enrolled,
        mfaVerified: mfa,
      });
    }
    if (path === "/api/staff/mfa/enroll") {
      enrollRequests++;
      return json({ secret, uri });
    }
    if (path === "/api/staff/mfa/confirm") {
      if (request.postDataJSON().code !== "123456")
        return json({ error: "invalid_code" }, 401);
      mfa = true;
      return json({
        recoveryCodes: enrolled
          ? []
          : ["synthetic-recovery-one", "synthetic-recovery-two"],
      });
    }
    if (path === "/api/staff/sessions")
      return json(mfa ? [] : { error: "mfa_required" }, mfa ? 200 : 403);
    return json({ error: "not_found" }, 404);
  });
  return {
    starts: () => startRequests,
    enrolls: () => enrollRequests,
    me: () => meRequests,
  };
}
async function open(page: Page, id: boolean, next = "/staff/account") {
  await page.goto(`/staff/login?next=${encodeURIComponent(next)}`);
  await selectLanguage(page, id ? "id" : "en");
}
async function googleButton(page: Page, id: boolean) {
  return page.getByRole("button", {
    name: id ? "Masuk dengan Google" : "Sign in with Google",
    exact: true,
  });
}

test("password inputs wait for hydration and preserve quickly entered credentials", async ({
  page,
}) => {
  await mockGoogle(page);
  let release!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/_next/**/*.js*", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  await page.goto("/staff/login", { waitUntil: "commit" });
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Kata sandi", { exact: true });
  try {
    await expect(email).toBeDisabled();
    await expect(password).toBeDisabled();
  } finally {
    release();
  }
  await email.fill("staff@gmail.com");
  await password.fill("Synthetic password input");
  await expect(await googleButton(page, true)).toBeVisible();
  await expect(email).toHaveValue("staff@gmail.com");
  await expect(password).toHaveValue("Synthetic password input");
});

test("Google redirect resumes local MFA and retains the staff deep link", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    auth = await mockGoogle(page);
  await open(page, id, "/staff/account?tab=sessions");
  await (await googleButton(page, id)).click();
  const code = page.getByLabel(
    id ? "Kode autentikator atau pemulihan" : "Authenticator or recovery code",
  );
  await expect(code).toBeVisible();
  await expect(page).toHaveURL(/\/staff\/login\?next=/);
  expect(auth.starts()).toBe(1);
  expect(auth.me()).toBe(1);
  expect(auth.enrolls()).toBe(0);
  await expect(page.locator(".mfa-qr")).toHaveCount(0);
  await code.fill("invalid");
  await page
    .getByRole("button", { name: id ? "Verifikasi" : "Verify", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/staff\/login/);
  await code.fill("123456");
  await page
    .getByRole("button", { name: id ? "Verifikasi" : "Verify", exact: true })
    .click();
  await expect(page).toHaveURL("/staff/account?tab=sessions");
  await expect(
    page.getByRole("heading", { name: id ? "Akun" : "Account", exact: true }),
  ).toBeVisible();
});

test("Google login requires enrollment and saving recovery codes for unenrolled staff", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    auth = await mockGoogle(page, { enrolled: false });
  await open(page, id);
  await (await googleButton(page, id)).click();
  await expect(page.locator(".mfa-qr")).toBeVisible();
  expect(auth.enrolls()).toBe(1);
  await page
    .getByLabel(
      id
        ? "Kode autentikator atau pemulihan"
        : "Authenticator or recovery code",
    )
    .fill("123456");
  await page
    .getByRole("button", { name: id ? "Verifikasi" : "Verify", exact: true })
    .click();
  await expect(page.getByText("synthetic-recovery-one")).toBeVisible();
  await expect(page).toHaveURL(/\/staff\/login/);
  await page
    .getByRole("button", {
      name: id
        ? "Saya telah menyimpan rahasia saya"
        : "I have saved my secrets",
    })
    .click();
  await expect(page).toHaveURL("/staff/account");
});

test("Google is hidden when disabled and on the password-reset form", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  await mockGoogle(page, { enabled: false });
  await open(page, id);
  await expect(await googleButton(page, id)).toHaveCount(0);
  await expect(
    page.getByLabel(id ? "Kata sandi" : "Password", { exact: true }),
  ).toBeVisible();
});

test("reset keeps its existing form without Google login", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  await mockGoogle(page);
  await open(page, id);
  await expect(await googleButton(page, id)).toBeVisible();
  await page
    .getByRole("button", {
      name: id
        ? "Kirim tautan pengaturan kata sandi"
        : "Send password reset link",
      exact: true,
    })
    .click();
  await expect(await googleButton(page, id)).toHaveCount(0);
});

for (const failure of [
  "google_cancelled",
  "google_ineligible",
  "google_failed",
  "google_expired",
]) {
  test(`Google ${failure} offers localized feedback and retry`, async ({
    page,
  }, info) => {
    const id = info.project.name === "mobile-id";
    await mockGoogle(page, { failure });
    await open(page, id);
    await (await googleButton(page, id)).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(
      page.getByLabel(id ? "Kata sandi" : "Password", { exact: true }),
    ).toBeVisible();
    await expect(await googleButton(page, id)).toBeEnabled();
    await expect(page).not.toHaveURL(/googleError=/);
  });
}

test("a forged continuation flag or expired session cannot enter the MFA flow", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  await mockGoogle(page, { expired: true });
  await open(page, id);
  await page.goto("/staff/login?google=continue&next=https%3A%2F%2Fevil.test");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    id ? "kedaluwarsa" : "expired",
  );
  await expect(
    page.getByLabel(id ? "Kata sandi" : "Password", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".mfa-qr")).toHaveCount(0);
});

test("external return URLs are replaced before starting Google authentication", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  await mockGoogle(page);
  await open(page, id, "https://evil.test/staff");
  const requestPromise = page.waitForRequest((request) =>
    request.url().endsWith("/api/staff/google/start"),
  );
  await (await googleButton(page, id)).click();
  expect((await requestPromise).postDataJSON().next).toBe("/staff");
  await expect(
    page.getByLabel(
      id
        ? "Kode autentikator atau pemulihan"
        : "Authenticator or recovery code",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
