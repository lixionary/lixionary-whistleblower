import { selectLanguage } from "./language";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { generate, generateSecret, generateURI, verify } from "otplib";
import jsQR from "jsqr";

// Synthetic API fixtures keep enrollment tests independent of company data.
async function mockStaffAuth(page: Page, enrolled = false) {
  const secret = generateSecret();
  const uri = generateURI({
    issuer: "Speak Up",
    label: "e2e-qr@example.test",
    secret,
  });
  let enrollRequests = 0;
  await page.route("**/api/staff/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/staff/login") {
      await route.fulfill({ json: { mfaEnrolled: enrolled } });
    } else if (path === "/api/staff/mfa/enroll") {
      enrollRequests++;
      await route.fulfill({ json: { secret, uri } });
    } else if (path === "/api/staff/mfa/confirm") {
      const { code } = route.request().postDataJSON();
      const valid =
        /^\d{6}$/.test(code) && (await verify({ secret, token: code })).valid;
      await route.fulfill(
        valid
          ? {
              json: {
                recoveryCodes: ["test-recovery-one", "test-recovery-two"],
              },
            }
          : { status: 401, json: { error: "invalid_code" } },
      );
    } else {
      await route.fulfill({ status: 404, json: { error: "not_found" } });
    }
  });
  return { secret, uri, enrollRequests: () => enrollRequests };
}

async function signIn(page: Page, id: boolean) {
  await page.goto("/staff/login");
  await selectLanguage(page, id ? "id" : "en");
  await page.getByLabel("Email", { exact: true }).fill("e2e-qr@example.test");
  await page
    .getByLabel(id ? "Kata sandi" : "Password", { exact: true })
    .fill("Synthetic browser test password");
  await page
    .getByRole("button", { name: id ? "Masuk" : "Sign in", exact: true })
    .click();
}

async function decodeQr(qr: Locator) {
  const pixels = await qr.evaluate(async (svg) => {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to rasterize QR code"));
    });
    image.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await loaded;
    const canvas = document.createElement("canvas");
    const bounds = svg.getBoundingClientRect();
    canvas.width = Math.round(bounds.width);
    canvas.height = Math.round(bounds.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      ),
    };
  });
  return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)
    ?.data;
}

test("MFA enrollment QR encodes the URI and persists until verified", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  const auth = await mockStaffAuth(page);
  await signIn(page, id);
  const qr = page.getByRole("img", {
    name: id ? "Kode QR penyiapan autentikator" : "Authenticator setup QR code",
  });
  await expect(qr).toBeVisible();
  expect(await decodeQr(qr)).toBe(auth.uri);
  await expect(page.locator("p.secret")).toHaveText(auth.secret);
  await expect(
    page.getByText(id ? "Kunci penyiapan manual" : "Manual setup key", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: id ? "Buka aplikasi autentikator" : "Open authenticator app",
    }),
  ).toHaveAttribute("href", auth.uri);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const code = page.getByLabel(
    id ? "Kode autentikator atau pemulihan" : "Authenticator or recovery code",
  );
  const confirm = page.getByRole("button", {
    name: id ? "Verifikasi" : "Verify",
    exact: true,
  });
  await code.fill("invalid");
  await confirm.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    id ? "Kode salah" : "Invalid or already used code",
  );
  await expect(qr).toBeVisible();
  await expect(page.locator("p.secret")).toHaveText(auth.secret);

  const decodedSecret = new URL((await decodeQr(qr))!).searchParams.get(
    "secret",
  )!;
  await code.fill(await generate({ secret: decodedSecret }));
  await confirm.click();
  await expect(
    page.getByText("test-recovery-one", { exact: true }),
  ).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expect(page.locator("p.secret")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(auth.enrollRequests()).toBe(1);
});

test("enrolled staff sign in without an enrollment QR or key", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  const auth = await mockStaffAuth(page, true);
  await signIn(page, id);
  await expect(
    page.getByLabel(
      id
        ? "Kode autentikator atau pemulihan"
        : "Authenticator or recovery code",
    ),
  ).toBeVisible();
  await expect(page.locator(".mfa-qr")).toHaveCount(0);
  await expect(page.locator("p.secret")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /authenticator|autentikator/ }),
  ).toHaveCount(0);
  expect(auth.enrollRequests()).toBe(0);
});
