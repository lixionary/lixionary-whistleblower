ALTER TABLE intakes ADD COLUMN draft_enc text;
--> statement-breakpoint
ALTER TABLE intakes ADD COLUMN submission_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX intakes_token_hash ON intakes(token_hash);
