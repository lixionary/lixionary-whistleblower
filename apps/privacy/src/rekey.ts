import { sql } from "drizzle-orm";
import { safeError, seal, unseal } from "@whistle/runtime";
import { loadConfig } from "./config.js";
import { createDb, rows } from "./db/client.js";
import { fileBytes, store } from "./service.js";
const config = loadConfig(),
  { db, close } = createDb(config.dbUrl);
try {
  await db.transaction(async (tx) => {
    for (const [table, column, prefix] of [
      ["admission_challenges", "email_enc", "admission-challenge"],
      ["contacts", "destination_enc", "contact"],
      ["intakes", "transcript_enc", "intake"],
      ["intakes", "state_enc", "conversation"],
      ["intakes", "draft_enc", "intake-draft"],
      ["conversation_operations", "input_enc", "conversation-input"],
      ["conversation_operations", "result_enc", "conversation-result"],
      ["delivery_jobs", "body_enc", "job"],
    ] as const) {
      for (const row of await rows(
        tx,
        sql`select id,${sql.identifier(column)} value from ${sql.identifier(table)} where ${sql.identifier(column)} is not null for update`,
      ))
        await rows(
          tx,
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)}=${seal(unseal(String(row.value), config.keys, `${prefix}:${row.id}`), config.keys, `${prefix}:${row.id}`)} where id=${row.id}`,
        );
    }
    for (const f of await rows(tx, sql`select * from files for update`)) {
      await store(
        config,
        String(f.id),
        "original",
        await fileBytes(config, String(f.id), "original"),
      );
      if (f.derivative_path)
        await store(
          config,
          String(f.id),
          "derivative",
          await fileBytes(config, String(f.id), "derivative"),
        );
    }
  });
  console.log(
    "Private fields and sealed evidence re-encrypted under the active key.",
  );
} catch (e) {
  console.error(safeError(e));
  process.exitCode = 1;
} finally {
  await close();
}
