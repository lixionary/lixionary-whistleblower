import { test, expect, type Page } from "@playwright/test";
import {
  defaultSettings,
  intakeGreeting,
  intakeReviewSchema,
  type PrivateIntakeView,
} from "@whistle/shared";
import { selectLanguage } from "./language";

async function fixture(page: Page, lang: "en" | "id") {
  await page.addInitScript((l) => localStorage.setItem("wb_language", l), lang);
  let code = "",
    submitted: any = null;
  const files: any[] = [];
  const bodies: any[] = [],
    admissions: string[] = [];
  const state: PrivateIntakeView = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    locale: lang,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    policyVersion: 1,
    needsConsent: false,
    aiEnabled: true,
    messages: [],
    draft: null,
    pending: null,
    usage: {
      messages: 0,
      drafts: 0,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  const f = {
    state,
    bodies,
    files,
    admissions,
    fail: false,
    disabled: false,
    expired: false,
    policy: 1,
    collisions: 0,
    get code() {
      return code;
    },
    get submitted() {
      return submitted;
    },
  };
  await page.route("**/api/reporter/company", (route) =>
    route.fulfill({
      json: { ...defaultSettings, aiEnabled: !f.disabled, version: f.policy },
    }),
  );
  await page.route("**/api/reporter/reports", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        caseCode: "WB-TEST-1234",
        pin: "synthetic-access",
        recoveryCode: "synthetic-recovery",
      },
    });
  });
  await page.route("**/privacy/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      body =
        req.postData() &&
        req.headers()["content-type"]?.includes("application/json")
          ? req.postDataJSON()
          : undefined;
    if (path.includes("/admission/")) {
      admissions.push(path);
      return route.fulfill({
        status: 500,
        json: { error: "unexpected_admission" },
      });
    }
    if (path === "/privacy/intake") {
      if (f.collisions > 0) {
        f.collisions--;
        return route.fulfill({
          status: 409,
          json: { error: "continuation_code_unavailable" },
        });
      }
      code = body.code;
      state.id = body.id;
      state.messages = [
        { role: "assistant", content: intakeGreeting(body.locale) },
      ];
      return route.fulfill({ json: state });
    }
    expect(req.headers()["x-intake-code"]).toBe(
      code || req.headers()["x-intake-code"],
    );
    if (f.expired)
      return route.fulfill({ status: 410, json: { error: "intake_expired" } });
    if (path.endsWith("/resume")) {
      if (req.headers()["x-intake-code"] !== code || submitted)
        return route.fulfill({
          status: 401,
          json: { error: "invalid_intake" },
        });
      return route.fulfill({ json: state });
    }
    if (path.endsWith("/files") && req.method() === "POST") {
      const id =
        req.headers()["x-evidence-id"] ??
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      files.push({
        id,
        status: "review",
        mime: "image/png",
        pages: 1,
        sha256: "a".repeat(64),
        size: 68,
        error_code: null,
      });
      return route.fulfill({
        status: 202,
        json: { id, status: "quarantined" },
      });
    }
    if (path.endsWith("/files")) return route.fulfill({ json: { files } });
    if (path.includes("/files/")) {
      const file = files.find((f) => path.includes(f.id));
      if (path.endsWith("/preview"))
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      if (path.endsWith("/approve")) {
        file.status = "approved";
        return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith("/redact")) {
        file.sha256 = "b".repeat(64);
        return route.fulfill({ json: { ok: true } });
      }
      if (req.method() === "DELETE") {
        files.splice(files.indexOf(file), 1);
        return route.fulfill({ json: { ok: true } });
      }
    }
    if (req.method() === "DELETE") {
      state.messages = [];
      return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === "PATCH") {
      state.locale = body.locale;
      if (body.draft) state.draft = body.draft;
      return route.fulfill({ json: state });
    }
    if (req.method() === "GET") return route.fulfill({ json: state });
    bodies.push({ path, ...body });
    if (body.policyVersion !== f.policy)
      return route.fulfill({ status: 409, json: { error: "policy_changed" } });
    if (path.endsWith("/messages")) {
      state.usage.messages++;
      if (!body.retryOf)
        state.messages.push({ role: "user", content: body.body });
      if (f.fail) {
        state.pending = {
          id: body.requestId,
          kind: "messages",
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
        content:
          body.locale === "id"
            ? "Kapan kejadian ini terjadi?"
            : "When did this happen?",
      });
    }
    if (path.endsWith("/draft")) {
      state.usage.drafts++;
      state.draft = intakeReviewSchema.parse({
        title: "Generated concern for review",
        summary:
          "The reporter described a procurement concern that investigators should review.",
        category: "fraud",
        locale: body.locale,
        details: { where: "Warehouse A" },
      });
    }
    return route.fulfill({ json: state });
  });
  return f;
}
async function start(page: Page, id: boolean) {
  const label = (en: string, indo: string) => (id ? indo : en);
  const assistant = page.getByRole("region", {
    name: label("Private reporting assistant", "Asisten pelaporan pribadi"),
    exact: true,
  });
  await assistant
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await assistant.getByLabel(/MiniMax/).check();
  await assistant
    .getByLabel(label("Message to assistant", "Pesan untuk asisten"))
    .fill("I saw a suspicious invoice in Warehouse A.");
  await assistant
    .getByRole("button", { name: label("Send", "Kirim"), exact: true })
    .click();
  return assistant;
}

test("Enter sends, Shift+Enter adds a line, and composition and repeated keys do not send", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  await page.goto("/report");
  const assistant = page.getByRole("region", {
    name: label("Private reporting assistant", "Asisten pelaporan pribadi"),
  });
  const input = assistant.getByLabel(
    label("Message to assistant", "Pesan untuk asisten"),
  );
  await input.fill("First line");
  await input.press("Enter");
  expect(f.bodies).toEqual([]);
  await assistant
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await input.press("Enter");
  expect(f.bodies).toEqual([]);
  await assistant.getByLabel(/MiniMax/).check();
  await input.press("End");
  await input.press("Shift+Enter");
  await input.pressSequentially("Second line");
  await expect(input).toHaveValue("First line\nSecond line");
  expect(f.bodies).toEqual([]);
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
  });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    repeat: true,
  });
  expect(f.bodies).toEqual([]);
  await input.press("Enter");
  await expect.poll(() => f.bodies.length).toBe(1);
  expect(f.bodies[0].body).toBe("First line\nSecond line");
  await expect(input).toHaveValue("");
  await input.press("Enter");
  expect(f.bodies).toHaveLength(1);
});

test("a reserved continuation code is retried without losing the message or draft identity", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    f = await fixture(page, id ? "id" : "en"),
    attempts: any[] = [];
  f.collisions = 1;
  page.on("request", (req) => {
    if (
      new URL(req.url()).pathname === "/privacy/intake" &&
      req.method() === "POST"
    )
      attempts.push(req.postDataJSON());
  });
  await page.goto("/report");
  await start(page, id);
  await expect.poll(() => f.bodies.length).toBe(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[0].id).toBe(attempts[1].id);
  expect(attempts[0].code).not.toBe(attempts[1].code);
  expect(f.code).toBe(attempts[1].code);
  await expect(page.getByText(f.code, { exact: true })).toBeVisible();
});

test("chat first, selected language, private code, editable review, resume and final receipt", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  await page.goto("/report");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: label("Title", "Judul"), exact: true }),
  ).not.toBeVisible();
  await expect(page.getByRole("log")).toContainText(id ? "Halo" : "Hello");
  await expect(
    page.getByText(label("Your Assistant", "Asisten Anda"), { exact: true }),
  ).toBeVisible();
  expect(f.bodies).toEqual([]);
  const assistant = await start(page, id);
  await expect(page.getByText(f.code, { exact: true })).toBeVisible();
  expect(f.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  await expect(page.locator("dd.case-id")).toHaveCount(0);
  expect(f.submitted).toBeNull();
  await selectLanguage(page, id ? "en" : "id");
  await page
    .getByLabel(id ? "Message to assistant" : "Pesan untuk asisten")
    .fill("It happened yesterday.");
  await page
    .getByRole("button", { name: id ? "Send" : "Kirim", exact: true })
    .click();
  await expect.poll(() => f.bodies.at(-1)?.locale).toBe(id ? "en" : "id");
  await selectLanguage(page, id ? "id" : "en");
  await assistant
    .getByRole("button", {
      name: label("Review report", "Tinjau laporan"),
      exact: true,
    })
    .click();
  const review = page.getByRole("form", {
    name: label("Review report", "Tinjau laporan"),
    exact: true,
  });
  await review
    .getByRole("textbox", {
      name: label("What happened?", "Apa yang terjadi?"),
      exact: true,
    })
    .fill(
      "Only this edited and reviewed report reaches the investigation team.",
    );
  await page
    .getByRole("button", {
      name: label("Save draft", "Simpan draf"),
      exact: true,
    })
    .click();
  await expect.poll(() => f.state.draft?.summary).toContain("Only this edited");
  const code = f.code;
  await page.reload();
  await page
    .getByLabel(label("Continuation code", "Kode untuk melanjutkan"), {
      exact: true,
    })
    .fill(code.toLowerCase().replace("-", ""));
  await page
    .getByRole("button", {
      name: label("Continue conversation", "Lanjutkan percakapan"),
      exact: true,
    })
    .click();
  await expect(page.getByRole("log")).toContainText("It happened yesterday.");
  await page
    .getByRole("button", {
      name: label("Review report", "Tinjau laporan"),
      exact: true,
    })
    .click();
  await expect(
    review.getByRole("textbox", {
      name: label("What happened?", "Apa yang terjadi?"),
      exact: true,
    }),
  ).toHaveValue(
    "Only this edited and reviewed report reaches the investigation team.",
  );
  await page
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  const submit = review.getByRole("button", {
    name: label("Submit report", "Kirim laporan"),
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await review
    .getByRole("textbox", { name: label("Title", "Judul"), exact: true })
    .fill("Corrected concern title");
  await expect(submit).toBeDisabled();
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await submit.click();
  await expect(page.locator("dd.case-id")).toHaveText("WB-TEST-1234");
  await expect(page.locator("dd.secret")).toHaveCount(2);
  expect(f.submitted).toMatchObject({
    intakeId: f.state.id,
    intakeToken: code,
    summary:
      "Only this edited and reviewed report reaches the investigation team.",
  });
  expect(f.admissions).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    "wb_language",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("ai-first-receipt.png"),
    fullPage: true,
  });
});

test("AI failure preserves conversation and allows manual reporting", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  f.fail = true;
  await page.goto("/report");
  const assistant = await start(page, id);
  await expect(assistant.getByRole("alert")).toBeVisible();
  await expect(page.getByText(f.code, { exact: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("suspicious invoice");
  f.fail = false;
  await assistant
    .getByRole("button", {
      name: label("Retry AI", "Coba lagi AI"),
      exact: true,
    })
    .click();
  await expect(page.getByRole("log")).toContainText(id ? "Kapan" : "When");
  expect(f.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
  await assistant
    .getByRole("button", {
      name: label("Use a form instead", "Gunakan formulir"),
      exact: true,
    })
    .click();
  const review = page.getByRole("form", {
    name: label("Review report", "Tinjau laporan"),
    exact: true,
  });
  await expect(review).toBeVisible();
  await review
    .getByRole("textbox", { name: label("Title", "Judul"), exact: true })
    .fill("Manual concern after failure");
  await review
    .getByRole("textbox", {
      name: label("What happened?", "Apa yang terjadi?"),
      exact: true,
    })
    .fill("This concern was completed manually without another AI response.");
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await review
    .getByRole("button", {
      name: label("Submit report", "Kirim laporan"),
      exact: true,
    })
    .click();
  await expect(page.locator("dd.case-id")).toHaveText("WB-TEST-1234");
});

test("manual reporting works without AI consent or an email admission gate", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  f.disabled = true;
  await page.goto("/report");
  await page
    .getByRole("button", {
      name: label("Use a form instead", "Gunakan formulir"),
      exact: true,
    })
    .click();
  const review = page.getByRole("form", {
    name: label("Review report", "Tinjau laporan"),
    exact: true,
  });
  await review
    .getByRole("textbox", { name: label("Title", "Judul"), exact: true })
    .fill("Anonymous manual concern");
  await review
    .getByRole("textbox", {
      name: label("What happened?", "Apa yang terjadi?"),
      exact: true,
    })
    .fill(
      "This report is submitted without AI consent or contact information.",
    );
  await page
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await review
    .getByRole("button", {
      name: label("Submit report", "Kirim laporan"),
      exact: true,
    })
    .click();
  await expect(page.locator("dd.case-id")).toHaveText("WB-TEST-1234");
  expect(f.bodies).toEqual([]);
  expect(f.admissions).toEqual([]);
  expect(f.submitted.aiConsent).toBe(false);
  expect(f.submitted.intakeId).toBeUndefined();
});

test("expired continuation codes show a localized error", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  f.expired = true;
  await page.goto("/report#continue");
  await page
    .getByLabel(label("Continuation code", "Kode untuk melanjutkan"), {
      exact: true,
    })
    .fill("x".repeat(43));
  await page
    .getByRole("button", {
      name: label("Continue conversation", "Lanjutkan percakapan"),
      exact: true,
    })
    .click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    id ? "kedaluwarsa" : "expired",
  );
});

test("evidence before a message works without AI, resumes and is approved before manual submission", async ({
  page,
}, info) => {
  const id = info.project.name === "mobile-id",
    label = (en: string, indo: string) => (id ? indo : en),
    f = await fixture(page, id ? "id" : "en");
  f.disabled = true;
  await page.goto("/report");
  const upload = page.locator("input[type=file]");
  await expect(upload).toBeDisabled();
  await page
    .getByRole("region", {
      name: label("Private reporting assistant", "Asisten pelaporan pribadi"),
    })
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await upload.setInputFiles({
    name: "evidence.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect.poll(() => f.files.length).toBe(1);
  const code = f.code;
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  expect(f.bodies).toEqual([]);
  await expect(page.locator("dd.case-id")).toHaveCount(0);
  await page.reload();
  await page
    .getByLabel(label("Continuation code", "Kode untuk melanjutkan"), {
      exact: true,
    })
    .fill(code);
  await page
    .getByRole("button", {
      name: label("Continue conversation", "Lanjutkan percakapan"),
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: label("Preview", "Pratinjau"), exact: true })
    .click();
  const approve = page.getByRole("button", {
    name: label("Approve evidence", "Setujui bukti"),
    exact: true,
  });
  await expect(approve).toBeDisabled();
  await page
    .getByLabel(
      label(
        "I reviewed every page and removed identifying details.",
        "Saya meninjau setiap halaman dan menghapus detail identitas.",
      ),
    )
    .check();
  await approve.click();
  await expect.poll(() => f.files[0]?.status).toBe("approved");
  await page.screenshot({
    path: test.info().outputPath("private-chat-evidence.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: label("Use a form instead", "Gunakan formulir"),
      exact: true,
    })
    .click();
  const review = page.getByRole("form", {
    name: label("Review report", "Tinjau laporan"),
    exact: true,
  });
  await review
    .getByRole("textbox", { name: label("Title", "Judul"), exact: true })
    .fill("Concern with private evidence");
  await review
    .getByRole("textbox", {
      name: label("What happened?", "Apa yang terjadi?"),
      exact: true,
    })
    .fill(
      "This reviewed concern has evidence uploaded without any AI processing.",
    );
  await page
    .getByLabel(
      label(
        "I have read the policy and privacy notice.",
        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
      ),
    )
    .check();
  await review
    .getByLabel(
      label(
        "I reviewed this content and removed details that could identify me.",
        "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
      ),
    )
    .check();
  await review
    .getByRole("button", {
      name: label("Submit report", "Kirim laporan"),
      exact: true,
    })
    .click();
  await expect(page.locator("dd.case-id")).toHaveText("WB-TEST-1234");
  expect(f.submitted).toMatchObject({
    intakeId: f.state.id,
    intakeToken: code,
    aiConsent: false,
  });
  expect(f.bodies).toEqual([]);
});
