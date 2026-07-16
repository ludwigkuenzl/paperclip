CREATE TABLE IF NOT EXISTS "resource_control_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "resource_key" text NOT NULL,
  "action_class" text NOT NULL,
  "owner_run_id" uuid,
  "issue_id" uuid,
  "change_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "fencing_token" bigint NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "released_at" timestamp with time zone,
  "release_reason" text,
  "target_readback_verified_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_company_id_companies_id_fk') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_owner_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_owner_run_id_heartbeat_runs_id_fk"
      FOREIGN KEY ("owner_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_issue_id_issues_id_fk') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_issue_id_issues_id_fk"
      FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_status_check') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_status_check"
      CHECK ("status" IN ('active', 'completed', 'released', 'recovery_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_action_class_check') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_action_class_check"
      CHECK ("action_class" IN ('vault_write', 'shared_write', 'deploy', 'external_action'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_control_leases_fencing_token_check') THEN
    ALTER TABLE "resource_control_leases" ADD CONSTRAINT "resource_control_leases_fencing_token_check"
      CHECK ("fencing_token" > 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_control_leases_company_resource_idx"
  ON "resource_control_leases" USING btree ("company_id", "resource_key", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_control_leases_owner_run_idx"
  ON "resource_control_leases" USING btree ("owner_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_control_leases_active_resource_uq"
  ON "resource_control_leases" USING btree ("company_id", "resource_key") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_control_leases_idempotency_uq"
  ON "resource_control_leases" USING btree ("company_id", "action_class", "resource_key", "idempotency_key");
