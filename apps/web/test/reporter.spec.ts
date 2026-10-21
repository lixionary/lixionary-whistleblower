import { selectLanguage } from "./language";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
test("anonymous reporting, secret receipt, private conversation and recovery", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id";
  await page.goto("/");
  await selectLanguage(page, id ? "id" : "en");
  await page
    .getByRole("link", { name: id ? "Buat laporan" : "Create a report" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: id ? "Gunakan formulir" : "Use a form instead",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: id ? "Tinjau laporan Anda" : "Review your report",
    }),
  ).toBeVisible();
  await page
    .getByLabel(
      id
        ? "Saya telah membaca kebijakan dan pemberitahuan privasi."
        : "I have read the policy and privacy notice.",
    )
    .check();
  await page
    .getByLabel(id ? "Judul" : "Title", { exact: true })
    .fill("Browser test procurement concern " + randomBytes(3).toString("hex"));
  await page
    .getByLabel(id ? "Apa yang terjadi?" : "What happened?", { exact: true })
    .fill(
      "This anonymous test report describes a suspected procurement issue for the review team.",
    );
  await page
    .getByLabel(
      id
        ? "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya."
        : "I reviewed this content and removed details that could identify me.",
    )
    .check();
  await page
    .getByRole("button", { name: id ? "Kirim laporan" : "Submit report" })
    .click();
  await expect(page.locator("dd.case-id")).toHaveText(/WB-/);
  const caseCode = await page.locator("dd.case-id").textContent();
  const values = await page.locator("dd.secret").allTextContents();
  expect(values).toHaveLength(2);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k !== "wb_language"),
    ),
  ).toEqual([]);
  await page
    .getByLabel(
      id ? "Saya telah menyimpan rahasia saya" : "I have saved my secrets",
    )
    .check();
  await page
    .getByRole("button", { name: id ? "Buka laporan saya" : "Open my case" })
    .click();
  await expect(page.getByRole("heading", { name: caseCode! })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: id ? "Kontak pribadi opsional" : "Optional private contacts",
    }),
  ).toBeVisible();
  const contact = `e2e-private-${randomBytes(4).toString("hex")}@example.test`;
  await page
    .getByLabel(
      id
        ? "Alamat email atau nomor telepon internasional"
        : "Email address or international phone number",
    )
    .fill(contact);
  await page
    .getByRole("button", {
      name: id ? "Kirim kode verifikasi" : "Send verification code",
      exact: true,
    })
    .click();
  let otp = "";
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          "http://localhost:6403/api/v1/messages",
        );
        const box = await response.json();
        const match = box.messages?.find((m: { To: { Address: string }[] }) =>
          m.To.some((to) => to.Address === contact),
        );
        if (!match) return false;
        const message = await (
          await page.request.get(
            "http://localhost:6403/api/v1/message/" + match.ID,
          )
        ).json();
        otp =
          message.Text?.match(
            /(?:code is|verifikasi Anda adalah) (\d{6})/,
          )?.[1] ?? "";
        return !!otp;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page
    .getByLabel(id ? "Kode verifikasi" : "Verification code", { exact: true })
    .fill(otp);
  await page
    .getByRole("button", { name: id ? "Verifikasi" : "Verify", exact: true })
    .click();
  await expect(
    page.getByText(
      new RegExp(
        contact.replaceAll(".", "\\.") +
          " · " +
          (id ? "Kontak terverifikasi" : "Contact verified"),
      ),
    ),
  ).toBeVisible();
  const message = id
    ? "Informasi tambahan untuk peninjauan kasus ini."
    : "Additional facts for the review of this concern.";
  await page
    .getByLabel(id ? "Pesan" : "Message", { exact: true })
    .fill(message);
  await page
    .getByLabel(
      id
        ? "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya."
        : "I reviewed this content and removed details that could identify me.",
    )
    .check();
  await page
    .getByRole("button", { name: id ? "Kirim" : "Send", exact: true })
    .click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: id ? "Keluar" : "Sign out", exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await page
    .getByRole("link", {
      name: id ? "Buka laporan saya" : "Open my case",
      exact: true,
    })
    .first()
    .click();
  await page.getByLabel(id ? "Kode laporan" : "Case code").fill(caseCode!);
  await page
    .getByLabel(
      id ? "Pulihkan dengan rahasia tersimpan" : "Recover with saved secret",
    )
    .check();
  await page
    .getByLabel(id ? "Rahasia pemulihan" : "Recovery secret", { exact: true })
    .fill(values[1]!);
  await page
    .getByRole("button", { name: id ? "Buka laporan saya" : "Open my case" })
    .click();
  await expect(page.locator("dd.secret")).toHaveCount(2);
  expect(await page.locator("dd.secret").first().textContent()).not.toBe(
    values[0],
  );
  await page
    .getByLabel(
      id ? "Saya telah menyimpan rahasia saya" : "I have saved my secrets",
    )
    .check();
  await page
    .getByRole("button", { name: id ? "Buka laporan saya" : "Open my case" })
    .click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
