DROP TABLE IF EXISTS employee_requests CASCADE;
--> statement-breakpoint
ALTER TABLE admission_grants DROP CONSTRAINT IF EXISTS admission_grants_employee_id_fkey;
--> statement-breakpoint
ALTER TABLE admission_grants DROP COLUMN IF EXISTS employee_id;
--> statement-breakpoint
DROP TABLE IF EXISTS employees CASCADE;
