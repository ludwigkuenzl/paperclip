import { describe, expect, it } from "vitest";
import {
  readIssueLifecycleEnforcementConfig,
  resolveIssueLifecycleEnforcementMode,
  resolveIssueLifecycleEnforcementModeForCompany,
  shouldEmitStructuralParentWake,
} from "./issue-lifecycle-enforcement.js";

describe("issue lifecycle enforcement mode", () => {
  it("defaults unknown and absent values to shadow mode", () => {
    expect(resolveIssueLifecycleEnforcementMode(undefined)).toBe("shadow");
    expect(resolveIssueLifecycleEnforcementMode("unexpected")).toBe("shadow");
  });

  it("supports an immediate rollback and an explicit enforcement gate", () => {
    expect(resolveIssueLifecycleEnforcementMode("OFF")).toBe("off");
    expect(resolveIssueLifecycleEnforcementMode(" enforce ")).toBe("enforce");
    expect(shouldEmitStructuralParentWake("off")).toBe(true);
    expect(shouldEmitStructuralParentWake("shadow")).toBe(true);
    expect(shouldEmitStructuralParentWake("enforce")).toBe(false);
  });

  it("requires an explicit company canary and reads config without route restart", () => {
    const originalMode = process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT;
    const originalCompanies = process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS;
    try {
      process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
      delete process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS;
      expect(resolveIssueLifecycleEnforcementModeForCompany("company-1")).toBe("shadow");

      process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS = "company-1, company-2";
      expect(readIssueLifecycleEnforcementConfig("company-1")).toMatchObject({
        configuredMode: "enforce",
        effectiveMode: "enforce",
        canaryCompanyIds: ["company-1", "company-2"],
      });
      expect(resolveIssueLifecycleEnforcementModeForCompany("company-3")).toBe("shadow");

      process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "off";
      expect(resolveIssueLifecycleEnforcementModeForCompany("company-1")).toBe("off");
    } finally {
      if (originalMode === undefined) delete process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT;
      else process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = originalMode;
      if (originalCompanies === undefined) delete process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS;
      else process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS = originalCompanies;
    }
  });
});
