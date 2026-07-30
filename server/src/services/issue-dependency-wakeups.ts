import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "coalesced",
  "claimed",
  "completed",
] as const;

const SUPERSEDED_MARKER = ":superseded:";

export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

export async function findExistingIssueBlockersResolvedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Entwertet die Dependency-Wakes eines Blockers, wenn dieser aus einem
 * terminalen Zustand heraus wieder geoeffnet wird.
 *
 * Hintergrund: Der Idempotenzschluessel besteht nur aus abhaengigem Issue und
 * Blocker-Issue. Er kennt keine Generation. Nach dem ersten Abschluss bleibt ein
 * Wake mit Status `completed` stehen; wird der Blocker danach reopened und
 * erneut fertig, bildet der Live-Pfad denselben Schluessel, findet den alten
 * Eintrag und unterdrueckt den Wake. Der abhaengige Vorgang bleibt dann auf
 * `blocked` stehen, obwohl sein Blocker erledigt ist - genau der stille
 * Stillstand, der am 2026-07-30 im E2E-Test reproduziert wurde.
 *
 * Statt den Schluessel umzubauen (der Recovery-Backstop kennt nur Issue-IDs und
 * koennte keinen passenden Generationsmarker bilden) wird beim Reopen der alte
 * Schluessel umbenannt. Der Eintrag bleibt fuer den Audit-Trail erhalten, wird
 * von der Idempotenzsuche aber nicht mehr gefunden, sodass der naechste echte
 * Abschluss wieder einen Wake ausloest.
 */
export async function supersedeIssueBlockersResolvedWakesForBlocker(
  db: Db,
  input: {
    companyId: string;
    blockerIssueId: string;
    /**
     * Die abhaengigen Vorgaenge des Blockers. Die Live-Route prueft mit
     * `findExistingIssueBlockersResolvedWakeForAnyKey` gegen *alle* Blocker-
     * schluessel eines Vorgangs. Haengt ein Vorgang an mehreren Blockern, wuerde
     * die erledigte Zeile eines anderen Blockers den Wake weiterhin
     * unterdruecken. Verlaesst ein Blocker `done`, ist jeder seiner
     * abhaengigen Vorgaenge wieder unfertig -- damit sind saemtliche
     * Blocker-aufgeloest-Wakes dieser Vorgaenge veraltet, unabhaengig davon,
     * welcher Blocker sie ausgeloest hat.
     */
    dependentIssueIds?: string[];
    supersededAt?: Date;
  },
) {
  const suffix = `${SUPERSEDED_MARKER}${(input.supersededAt ?? new Date()).toISOString()}`;
  const rows = await db
    .select({ id: agentWakeupRequests.id, idempotencyKey: agentWakeupRequests.idempotencyKey })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    );

  const blockerMarker = `:${input.blockerIssueId}`;
  const dependentPrefixes = [...new Set(input.dependentIssueIds ?? [])]
    .filter(Boolean)
    .map((dependentIssueId) => `${ISSUE_BLOCKERS_RESOLVED_WAKE_REASON}:${dependentIssueId}:`);
  const affected = rows.filter((row) => {
    const key = row.idempotencyKey;
    if (typeof key !== "string") return false;
    if (!key.startsWith(`${ISSUE_BLOCKERS_RESOLVED_WAKE_REASON}:`)) return false;
    // Bereits entwertete Zeilen nicht erneut anfassen. Sie sperren nichts mehr,
    // und ein zweiter Suffix wuerde den Schluessel bei jedem weiteren
    // Reopen-Zyklus unbegrenzt wachsen lassen und die Zaehlung verfaelschen.
    if (key.includes(SUPERSEDED_MARKER)) return false;
    // Dieser Vorgang war selbst der aufgeloeste Blocker.
    if (key.endsWith(blockerMarker)) return true;
    // Oder die Zeile gehoert zu einem seiner abhaengigen Vorgaenge und wurde von
    // einem anderen Blocker geschrieben.
    return dependentPrefixes.some((prefix) => key.startsWith(prefix));
  });
  if (affected.length === 0) return 0;

  for (const row of affected) {
    await db
      .update(agentWakeupRequests)
      .set({ idempotencyKey: `${row.idempotencyKey}${suffix}` })
      .where(eq(agentWakeupRequests.id, row.id));
  }
  return affected.length;
}
