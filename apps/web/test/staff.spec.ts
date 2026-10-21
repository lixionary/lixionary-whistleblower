import { selectLanguage } from "./language";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { generate } from "otplib";
test("staff MFA and assigned review workflow preserve contact privacy", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    name = id ? "manager2" : "manager";
  await page.goto("/staff/login");
  await selectLanguage(page, id ? "id" : "en");
  await page
    .getByLabel("Email", { exact: true })
    .fill(`e2e-${name}@example.test`);
  await page
    .getByLabel(id ? "Kata sandi" : "Password", { exact: true })
    .fill("UI test-only long password");
  await page
    .getByRole("button", { name: id ? "Masuk" : "Sign in", exact: true })
    .click();
  await expect(page.locator("p.secret")).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: id
        ? "Kode QR penyiapan autentikator"
        : "Authenticator setup QR code",
    }),
  ).toBeVisible();
  const secret = await page.locator("p.secret").textContent();
  await page
    .getByLabel(
      id
        ? "Kode autentikator atau pemulihan"
        : "Authenticator or recovery code",
    )
    .fill(await generate({ secret: secret! }));
  await page
    .getByRole("button", { name: id ? "Verifikasi" : "Verify", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: id
        ? "Saya telah menyimpan rahasia saya"
        : "I have saved my secrets",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/staff\/cases$/);
  await expect(
    page.getByRole("heading", { name: id ? "Kasus" : "Cases", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: /WB-/ }).first().click();
  await expect(page.getByRole("heading", { name: /WB-/ })).toBeVisible();
  expect(await page.locator("main").textContent()).not.toContain(
    "e2e-private-",
  );
  const unauthorized = await page.request.get("/privacy/reporter/contacts");
  expect(unauthorized.status()).toBe(401);
  const triage = page.getByRole("button", {
    name: id ? "Peninjauan awal" : "Triage",
    exact: true,
  });
  if (await triage.count()) await triage.click();
  if (id)
    await page
      .getByRole("combobox", { name: "Bagian kasus" })
      .selectOption(page.url().replace(/^https?:\/\/[^/]+/, "") + "/messages");
  else
    await page
      .locator(".case-sections")
      .getByRole("link", { name: "Private conversation", exact: true })
      .click();
  const message =
    (id
      ? "Tim sedang meninjau laporan anonim Anda."
      : "The team is reviewing your anonymous report.") +
    " " +
    randomUUID();
  const messageField = page.getByLabel(id ? "Pesan" : "Message", {
    exact: true,
  });
  await messageField.fill(message);
  await page
    .getByRole("button", { name: id ? "Kirim" : "Send", exact: true })
    .click();
  await expect(messageField).toHaveValue("");
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("administration manages configuration without viewing case or reporter identity", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Administrator smoke is covered on desktop.",
  );
  await page.goto("/staff/login");
  await selectLanguage(page, "en");
  await page
    .getByLabel("Email", { exact: true })
    .fill("e2e-admin@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("UI test-only long password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Authenticator setup QR code" }),
  ).toBeVisible();
  const secret = await page.locator("p.secret").textContent();
  await page
    .getByLabel("Authenticator or recovery code")
    .fill(await generate({ secret: secret! }));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page
    .getByRole("button", { name: "I have saved my secrets", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Company settings" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/staff\/admin\/settings$/);
  await page
    .locator("aside")
    .getByRole("link", { name: "Review teams", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review teams", exact: true }),
  ).toBeVisible();
  await page
    .locator("aside")
    .getByRole("link", { name: "Company settings", exact: true })
    .click();
  expect(await page.locator("main").textContent()).not.toContain(
    "e2e-private-",
  );
  const list = await page.request.get("/api/cases");
  expect(list.status()).toBe(200);
  expect((await list.json()).cases).toEqual([]);
  expect((await page.request.get("/privacy/reporter/contacts")).status()).toBe(
    401,
  );
  const settings = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Company settings", exact: true }),
  });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/admin/settings") && r.request().method() === "PUT",
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("main [role='alert']")).toHaveCount(0);
  // Exercise account invitation and administrator recovery with actual Mailpit delivery.
  const name = "E2E New user " + randomUUID(),
    email = `e2e-user-${randomUUID()}@example.test`;
  const mailboxIds = async () => {
    const box = await (
      await page.request.get("http://localhost:6403/api/v1/messages")
    ).json();
    return new Set<string>(box.messages?.map((m: { ID: string }) => m.ID));
  };
  const accessLink = async (previous: Set<string>) => {
    let link = "";
    await expect
      .poll(
        async () => {
          const box = await (
            await page.request.get("http://localhost:6403/api/v1/messages")
          ).json();
          const mail = box.messages?.find(
            (m: { ID: string; To: { Address: string }[] }) =>
              !previous.has(m.ID) && m.To.some((to) => to.Address === email),
          );
          if (!mail) return false;
          const body = await (
            await page.request.get(
              "http://localhost:6403/api/v1/message/" + mail.ID,
            )
          ).json();
          link =
            body.Text?.match(
              /https?:\/\/\S+\/staff\/accept#token=[A-Za-z0-9_-]+/,
            )?.[0] ?? "";
          return !!link;
        },
        { timeout: 30000 },
      )
      .toBe(true);
    return link;
  };
  const accept = async (link: string, nextPassword: string) => {
    const context = await page.context().browser()!.newContext();
    try {
      const target = await context.newPage();
      await target.goto(link);
      await target
        .getByLabel("New password (at least 15 characters)", { exact: true })
        .fill(nextPassword);
      await target.getByRole("button", { name: "Save", exact: true }).click();
      await expect(target).toHaveURL(/\/staff\/login$/);
    } finally {
      await context.close();
    }
  };
  await page
    .locator("aside")
    .getByRole("link", { name: "Users", exact: true })
    .click();
  await expect(page.getByRole("main").locator("input,select")).toHaveCount(0);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Create user", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  const beforeInvitation = await mailboxIds();
  await page.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/admin\/users\?notice=invited$/);
  await accept(
    await accessLink(beforeInvitation),
    "First synthetic account password",
  );
  await page
    .getByRole("main")
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Edit user " + name, exact: true })
    .click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByLabel("Active", { exact: true })).toBeChecked();
  const beforeReset = await mailboxIds();
  await page
    .getByRole("button", { name: "Send password reset email", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Password reset email queued.",
  );
  await accept(
    await accessLink(beforeReset),
    "Second synthetic account password",
  );
  await page.getByLabel("Name", { exact: true }).fill(name + " updated");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/admin\/users\?notice=saved$/);
  await expect(
    page.getByRole("link", {
      name: "Edit user " + name + " updated",
      exact: true,
    }),
  ).toBeVisible();
});
