ALTER TABLE intakes ADD COLUMN ai_consented boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN case_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE files ADD COLUMN intake_id uuid REFERENCES intakes(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE files ADD COLUMN storage_backend text NOT NULL DEFAULT 'filesystem' CHECK (storage_backend IN ('filesystem','s3'));
--> statement-breakpoint
ALTER TABLE files ADD CONSTRAINT files_owner CHECK (num_nonnulls(case_id,intake_id)=1);
--> statement-breakpoint
CREATE INDEX files_intake ON files(intake_id) WHERE intake_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE evidence_deletions(id uuid NOT NULL,storage_backend text NOT NULL CHECK(storage_backend IN ('filesystem','s3')),next_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,PRIMARY KEY(id,storage_backend));
--> statement-breakpoint
CREATE FUNCTION queue_evidence_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO evidence_deletions(id,storage_backend) VALUES(OLD.id,OLD.storage_backend) ON CONFLICT DO NOTHING; IF OLD.storage_backend='s3' THEN INSERT INTO evidence_deletions(id,storage_backend) VALUES(OLD.id,'filesystem') ON CONFLICT DO NOTHING; END IF; RETURN OLD; END $$;
--> statement-breakpoint
CREATE TRIGGER evidence_file_deleted AFTER DELETE ON files FOR EACH ROW EXECUTE FUNCTION queue_evidence_deletion();
