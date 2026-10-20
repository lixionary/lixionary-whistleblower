import { test, expect, type Page } from "@playwright/test";
import {
  defaultSettings,
  followupKeys,
  type ConversationView,
} from "@whistle/shared";

async function fixture(page: Page, id: boolean, optional = false) {
  await page.addInitScript(
    (lang) => localStorage.setItem("wb_language", lang),
    id ? "id" : "en",
  );
  const state: ConversationView = {
    consented: !optional,
    needsConsent: optional,
    policyVersion: 1,
    aiEnabled: true,
    initialized: false,
    messages: [],
    draft: null,
    pending: null,
    usage: { messages: 0, drafts: 0, resetsAt: "2026-10-18T00:00:00.000Z" },
  };
  const f = {
    state,
    signedIn: true,
    fail: false,
    starts: 0,
    aiCalls: 0,
    submitted: null as any,
    shared: [] as any[],
    requestBodies: [] as any[],
  };
  const report = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    caseCode: "WB-TEST-1234",
    state: "received",
    content: {
      title: "Original submitted concern",
      summary: "Original submitted report content remains unchanged.",
      details: {
        where: "Warehouse A",
        why: "Unknown",
        how: "Invoices were changed",
      },
    },
    messages: [] as any[],
    verification: { state: "none" },
    verificationRequests: [],
    publicOutcome: null,
  };
  await page.route("**/api/**", async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname,
      method = r.method(),
      body = r.postData() ? r.postDataJSON() : undefined;
    if (path === "/api/reporter/company")
      return route.fulfill({
        json: { ...defaultSettings, version: 1, aiEnabled: true },
      });
    if (path === "/api/reporter/reports") {
      f.submitted = body;
      f.signedIn = true;
      state.consented = body.aiConsent;
      state.needsConsent = !body.aiConsent;
      return route.fulfill({
        status: 201,
        json: {
          caseCode: report.caseCode,
          pin: "synthetic-secret",
          recoveryCode: "synthetic-recovery",
        },
      });
    }
    if (path === "/api/reporter/session") {
      f.signedIn = method !== "DELETE";
      return route.fulfill({ json: { ok: true } });
    }
    if (!f.signedIn)
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    if (path === "/api/reporter/case") return route.fulfill({ json: report });
    if (path === "/api/reporter/capability")
      return route.fulfill({
        json: { capability: "synthetic-session-capability" },
      });
    if (path === "/api/reporter/messages") {
      f.shared.push(body);
      report.messages.push({
        id: body.clientMessageId,
        author: "reporter",
        body: body.body,
        createdAt: new Date().toISOString(),
      });
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/privacy/**", async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname,
      method = r.method(),
      body = r.postData() ? r.postDataJSON() : undefined;
    if (path.startsWith("/privacy/admission/"))
      return route.fulfill({
        json: path.endsWith("challenge")
          ? {
              status: "otp",
              challengeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              expiresIn: 300,
              resendAfter: 60,
            }
          : { reportToken: "r".repeat(43), expiresIn: 7200 },
      });
    expect(r.headers().authorization).toBe(
      "Bearer synthetic-session-capability",
    );
    if (path === "/privacy/reporter/contacts")
      return route.fulfill({ json: { contacts: [] } });
    if (path === "/privacy/reporter/files")
      return route.fulfill({ json: { files: [] } });
    if (path.startsWith("/privacy/reporter/conversation")) {
      if (method === "GET") return route.fulfill({ json: state });
      f.requestBodies.push(body);
      if (path.endsWith("/draft") && method === "PATCH") {
        state.draft = body;
        return route.fulfill({ json: state });
      }
      if (path.endsWith("/draft") && method === "DELETE") {
        state.draft = null;
        return route.fulfill({ json: state });
      }
      if (method === "DELETE") {
        state.consented = false;
        state.needsConsent = true;
        state.messages = [];
        state.draft = null;
        state.initialized = false;
        return route.fulfill({ json: state });
      }
      f.aiCalls++;
      if (path.endsWith("/start")) {
        f.starts++;
        state.consented = true;
        state.needsConsent = false;
        state.initialized = true;
        state.usage.messages++;
        state.messages.push({
          role: "assistant",
          content: id
            ? "Detail yang dikirim sudah lengkap. Apakah informasinya benar?"
            : "The submitted details are complete. Is the information correct?",
        });
      }
      if (path.endsWith("/messages")) {
        state.usage.messages++;
        if (!body.retryOf)
          state.messages.push({ role: "user", content: body.body });
        if (f.fail) {
          state.pending = {
            id: body.requestId,
            kind: "messages",
            status: "failed",
            retryable: true,
          };
          return route.fulfill({
            status: 503,
            json: { error: "ai_unavailable" },
          });
        }
        state.pending = null;
        state.messages.push({
          role: "assistant",
          content: "Saved assistant follow-up",
        });
      }
      if (path.endsWith("/draft")) {
        state.usage.drafts++;
        state.draft = {
          summary: "Draft information for review",
          details: Object.fromEntries(
            followupKeys.map((k) => [k, k === "where" ? "Warehouse A" : ""]),
          ) as any,
          clientMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        };
      }
      return route.fulfill({ json: state });
    }
    return route.fulfill({ json: {} });
  });
  return f;
}

test("form, saved credentials, private AI, reviewed update and resumed history", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id);
  await page.goto("/report");
  await page
    .getByRole("button", {
      name: label("Use a form instead", "Gunakan formulir"),
      exact: true,
    })
    .click();
  await page
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await page
    .getByLabel(label("Title", "Judul"), { exact: true })
    .fill("Original submitted concern");
  await page
    .getByLabel(label("What happened?", "Apa yang terjadi?"), { exact: true })
    .fill("Original submitted report content remains unchanged.");
  await page
    .getByText(
      label("Additional details (optional)", "Detail tambahan (opsional)"),
      { exact: true },
    )
    .click();
  await page
    .getByLabel(
      label("Why did it happen, if known?", "Mengapa terjadi, jika diketahui?"),
      { exact: true },
    )
    .fill("Unknown");
  await page
    .getByLabel(label("How did it happen?", "Bagaimana kejadiannya?"), {
      exact: true,
    })
    .fill("Invoices were changed");
  await page.getByLabel(/MiniMax/).check();
  await expect(
    page.getByRole("button", {
      name: label("Send to AI", "Kirim ke AI"),
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await page
    .getByRole("button", {
      name: label("Submit report", "Kirim laporan"),
      exact: true,
    })
    .click();
  const open = page.getByRole("button", {
    name: label("Open my case", "Buka laporan saya"),
    exact: true,
  });
  await expect(open).toBeDisabled();
  expect(f.aiCalls).toBe(0);
  await expect(page.locator("dd.secret")).toHaveCount(2);
  await page
    .getByLabel(
      label("I have saved my secrets", "Saya telah menyimpan rahasia saya"),
    )
    .check();
  await open.click();
  const assistant = page.getByRole("region", {
    name: label("Private AI follow-up", "Tindak lanjut AI pribadi"),
    exact: true,
  });
  await expect(
    assistant.getByText(
      label(
        "The submitted details are complete. Is the information correct?",
        "Detail yang dikirim sudah lengkap. Apakah informasinya benar?",
      ),
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.starts).toBe(1);
  expect(f.submitted).toMatchObject({
    aiConsent: true,
    details: { why: "Unknown", how: "Invoices were changed" },
  });
  await assistant
    .getByLabel(label("Message to private AI", "Pesan untuk AI pribadi"))
    .fill("Yes, those details are correct.");
  await assistant
    .getByRole("button", {
      name: label("Send to AI", "Kirim ke AI"),
      exact: true,
    })
    .click();
  await expect(
    assistant.getByText("Saved assistant follow-up", { exact: true }),
  ).toBeVisible();
  expect(f.shared).toEqual([]);
  await page.reload();
  await expect(
    assistant.getByText("Yes, those details are correct.", { exact: true }),
  ).toBeVisible();
  expect(f.starts).toBe(1);
  await assistant
    .getByRole("button", {
      name: label("Review update", "Tinjau pembaruan"),
      exact: true,
    })
    .click();
  const review = assistant.getByRole("form", {
    name: label("Review AI update", "Tinjau pembaruan AI"),
    exact: true,
  });
  await review
    .getByLabel(label("Update summary", "Ringkasan pembaruan"))
    .fill("Only this reviewed content should reach investigators.");
  const share = review.getByRole("button", {
    name: label(
      "Share update with investigators",
      "Bagikan pembaruan kepada penyelidik",
    ),
    exact: true,
  });
  await expect(share).toBeDisabled();
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await share.click();
  await expect(review).not.toBeVisible();
  expect(f.shared).toHaveLength(1);
  expect(f.shared[0].body).toContain("Only this reviewed content");
  await expect(
    page.getByText("Original submitted report content remains unchanged.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: label("Sign out", "Keluar"), exact: true })
    .click();
  await expect(page).toHaveURL("/");
  await page.goto("/case");
  await page
    .getByLabel(label("Case code", "Kode laporan"), { exact: true })
    .fill("WB-TEST-1234");
  await page
    .getByLabel(label("Access secret", "Rahasia akses"), { exact: true })
    .fill("synthetic-secret");
  await page
    .getByRole("button", {
      name: label("Open my case", "Buka laporan saya"),
      exact: true,
    })
    .click();
  await expect(
    assistant.getByText("Yes, those details are correct.", { exact: true }),
  ).toBeVisible();
  expect(f.starts).toBe(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k !== "wb_language"),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `../../.suite-dev/form-first-${info.project.name}.png`,
    fullPage: true,
  });
});

test("optional consent and provider failure preserve a resumable private conversation", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id, true);
  await page.goto("/case");
  const assistant = page.getByRole("region", {
    name: label("Private AI follow-up", "Tindak lanjut AI pribadi"),
    exact: true,
  });
  await expect(
    assistant.getByRole("button", {
      name: label("Start private follow-up", "Mulai tindak lanjut pribadi"),
      exact: true,
    }),
  ).toBeDisabled();
  expect(f.starts).toBe(0);
  await assistant.getByLabel(/MiniMax/).check();
  await assistant
    .getByRole("button", {
      name: label("Start private follow-up", "Mulai tindak lanjut pribadi"),
      exact: true,
    })
    .click();
  f.fail = true;
  await assistant
    .getByLabel(label("Message to private AI", "Pesan untuk AI pribadi"))
    .fill("Keep this message through failure.");
  await assistant
    .getByRole("button", {
      name: label("Send to AI", "Kirim ke AI"),
      exact: true,
    })
    .click();
  await expect(assistant.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(
    assistant.getByText("Keep this message through failure.", { exact: true }),
  ).toBeVisible();
  f.fail = false;
  await assistant
    .getByRole("button", {
      name: label("Retry AI", "Coba lagi AI"),
      exact: true,
    })
    .click();
  await expect(
    assistant.getByText("Saved assistant follow-up", { exact: true }),
  ).toBeVisible();
  await expect(
    assistant.getByText("Keep this message through failure.", { exact: true }),
  ).toHaveCount(1);
  f.state.aiEnabled = false;
  await page.reload();
  await expect(
    assistant.getByText("Keep this message through failure.", { exact: true }),
  ).toBeVisible();
  await expect(
    assistant.getByRole("button", {
      name: label("Send to AI", "Kirim ke AI"),
      exact: true,
    }),
  ).toBeDisabled();
  await assistant
    .getByRole("button", {
      name: label(
        "Withdraw AI consent and erase conversation",
        "Tarik persetujuan AI dan hapus percakapan",
      ),
      exact: true,
    })
    .click();
  await expect(
    assistant.getByText("Keep this message through failure.", { exact: true }),
  ).not.toBeVisible();
});
