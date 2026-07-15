import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "./default-agent-instructions.js";

describe("default agent delivery-control instructions", () => {
  it.each(["default", "ceo"] as const)(
    "ships durable delivery-control rules for %s agents",
    async (role) => {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      const instructions = bundle["AGENTS.md"];

      expect(instructions).toContain("## Delivery control");
      expect(instructions).toContain("first-class blocker");
      expect(instructions).toContain("idempotent");
      expect(instructions).toContain("target-state readback");
      expect(instructions).toContain("next automatic check");
    },
  );

  it("uses the CEO bundle only for the CEO role", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
  });
});
