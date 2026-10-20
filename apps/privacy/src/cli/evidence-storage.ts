import { safeError } from "@whistle/runtime";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import {
  migrateEvidence,
  exportEvidence,
  importEvidence,
  purgeFilesystemCopies,
} from "../storage-admin.js";
import { drainEvidenceDeletions } from "../jobs.js";
const config = loadConfig(),
  { db, close } = createDb(config.dbUrl);
try {
  const [command, directory] = process.argv.slice(2);
  if (command === "migrate")
    console.log(
      `Verified and migrated ${await migrateEvidence(db, config)} evidence records. Filesystem originals retained.`,
    );
  else if (command === "purge-filesystem")
    console.log(
      `Verified and purged ${await purgeFilesystemCopies(db, config)} legacy filesystem copies.`,
    );
  else if (command === "export" && directory)
    console.log(
      `Exported ${await exportEvidence(db, config, directory)} sealed objects.`,
    );
  else if (command === "import" && directory)
    console.log(
      `Verified and restored ${await importEvidence(db, config, directory)} sealed objects.`,
    );
  else if (command === "cleanup") await drainEvidenceDeletions(db, config);
  else
    throw new Error(
      "Usage: evidence-storage migrate | purge-filesystem | export DIR | import DIR | cleanup",
    );
} catch (e) {
  console.error(safeError(e));
  process.exitCode = 1;
} finally {
  await close();
}
