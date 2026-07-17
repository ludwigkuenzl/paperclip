import { describe, expect, it } from "vitest";
import {
  defaultExecutionWorkspaceModeForProject,
  defaultExecutionWorkspaceSelectionForProject,
  defaultProjectWorkspaceIdForProject,
  executionWorkspaceSelectionLabel,
  issueExecutionWorkspaceModeForExistingWorkspace,
  projectLocksExecutionWorkspaceSelection,
} from "./project-workspace-defaults";

describe("project workspace defaults", () => {
  it("prefers the execution policy default workspace over the primary workspace", () => {
    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: { defaultProjectWorkspaceId: "workspace-policy" },
      workspaces: [
        { id: "workspace-primary", isPrimary: true },
        { id: "workspace-secondary", isPrimary: false },
      ],
    })).toBe("workspace-policy");
  });

  it("falls back to the primary workspace, then the first workspace", () => {
    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: null,
      workspaces: [
        { id: "workspace-one", isPrimary: false },
        { id: "workspace-two", isPrimary: true },
      ],
    })).toBe("workspace-two");

    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: null,
      workspaces: [{ id: "workspace-one", isPrimary: false }],
    })).toBe("workspace-one");
  });

  it("maps project and reusable execution workspace modes to issue settings modes", () => {
    expect(defaultExecutionWorkspaceModeForProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "adapter_default" },
    })).toBe("agent_default");

    expect(issueExecutionWorkspaceModeForExistingWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForExistingWorkspace("isolated_workspace")).toBe("isolated_workspace");
  });

  it("represents an enabled project policy as inheritance in issue controls", () => {
    const project = {
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
    };

    expect(defaultExecutionWorkspaceSelectionForProject(project)).toBe("inherit");
    expect(executionWorkspaceSelectionLabel(defaultExecutionWorkspaceModeForProject(project)))
      .toBe("New isolated workspace");
  });

  it("identifies projects that disallow issue-level workspace choices", () => {
    expect(projectLocksExecutionWorkspaceSelection({
      executionWorkspacePolicy: { enabled: true, allowIssueOverride: false },
    })).toBe(true);
    expect(projectLocksExecutionWorkspaceSelection({
      executionWorkspacePolicy: { enabled: true, allowIssueOverride: true },
    })).toBe(false);
    expect(projectLocksExecutionWorkspaceSelection({
      executionWorkspacePolicy: { enabled: false, allowIssueOverride: false },
    })).toBe(false);
  });
});
