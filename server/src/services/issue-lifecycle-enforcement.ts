export const ISSUE_LIFECYCLE_ENFORCEMENT_ENV = "PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT";
export const ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS_ENV =
  "PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS";

export type IssueLifecycleEnforcementMode = "off" | "shadow" | "enforce";

export function resolveIssueLifecycleEnforcementMode(
  value: string | null | undefined = process.env[ISSUE_LIFECYCLE_ENFORCEMENT_ENV],
): IssueLifecycleEnforcementMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "enforce") return normalized;
  return "shadow";
}

export function readIssueLifecycleEnforcementConfig(
  companyId: string,
  input: {
    mode?: string | null;
    canaryCompanyIds?: string | null;
  } = {},
) {
  const configuredMode = resolveIssueLifecycleEnforcementMode(
    input.mode === undefined ? process.env[ISSUE_LIFECYCLE_ENFORCEMENT_ENV] : input.mode,
  );
  const canaryCompanyIds = (
    input.canaryCompanyIds === undefined
      ? process.env[ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS_ENV]
      : input.canaryCompanyIds
  )
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const effectiveMode: IssueLifecycleEnforcementMode = configuredMode === "enforce"
    ? canaryCompanyIds.includes(companyId) ? "enforce" : "shadow"
    : configuredMode;
  return {
    configuredMode,
    effectiveMode,
    companyId,
    canaryCompanyIds,
  } as const;
}

export function resolveIssueLifecycleEnforcementModeForCompany(companyId: string) {
  return readIssueLifecycleEnforcementConfig(companyId).effectiveMode;
}

export function shouldEmitStructuralParentWake(mode: IssueLifecycleEnforcementMode) {
  return mode !== "enforce";
}
