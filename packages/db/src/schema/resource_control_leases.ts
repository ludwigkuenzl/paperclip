import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigint } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const resourceControlLeases = pgTable(
  "resource_control_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    resourceKey: text("resource_key").notNull(),
    actionClass: text("action_class").notNull(),
    ownerRunId: uuid("owner_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    changeId: text("change_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
    status: text("status").notNull().default("active"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    targetReadbackVerifiedAt: timestamp("target_readback_verified_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyResourceIdx: index("resource_control_leases_company_resource_idx").on(
      table.companyId,
      table.resourceKey,
      table.createdAt,
    ),
    ownerRunIdx: index("resource_control_leases_owner_run_idx").on(table.ownerRunId),
    activeResourceUq: uniqueIndex("resource_control_leases_active_resource_uq")
      .on(table.companyId, table.resourceKey)
      .where(sql`${table.status} = 'active'`),
    idempotencyUq: uniqueIndex("resource_control_leases_idempotency_uq").on(
      table.companyId,
      table.actionClass,
      table.resourceKey,
      table.idempotencyKey,
    ),
    statusCheck: check(
      "resource_control_leases_status_check",
      sql`${table.status} in ('active', 'completed', 'released', 'recovery_required')`,
    ),
    actionClassCheck: check(
      "resource_control_leases_action_class_check",
      sql`${table.actionClass} in ('vault_write', 'shared_write', 'deploy', 'external_action')`,
    ),
    fencingTokenCheck: check("resource_control_leases_fencing_token_check", sql`${table.fencingToken} > 0`),
  }),
);
