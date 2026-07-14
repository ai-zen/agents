import { describe, it, expect } from "vitest";
import { prefilterSubAgents, prefilterSkillTools } from "./prefilter";
import type { AgentDefinition } from "../types";

function def(name: string): AgentDefinition {
  return {
    id: name,
    name,
    messages: [{ role: "system", content: "You are helpful." }],
    function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("prefilterSubAgents", () => {
  const candidates: AgentDefinition[] = ["general_assistant", "code-reviewer", "deployer"].map(def);

  it("无自身无调用者 — 原样返回", () => {
    const result = prefilterSubAgents(candidates);
    expect(result.map(d => d.function!.name)).toEqual(["general_assistant", "code-reviewer", "deployer"]);
  });

  it("剔除自身", () => {
    const result = prefilterSubAgents(candidates, "code-reviewer");
    expect(result.map(d => d.function!.name)).toEqual(["general_assistant", "deployer"]);
  });

  it("剔除调用者", () => {
    const result = prefilterSubAgents(candidates, undefined, "general_assistant");
    expect(result.map(d => d.function!.name)).toEqual(["code-reviewer", "deployer"]);
  });

  it("同时剔除自身和调用者", () => {
    const result = prefilterSubAgents(candidates, "code-reviewer", "general_assistant");
    expect(result.map(d => d.function!.name)).toEqual(["deployer"]);
  });

  it("自身和调用者同名 — 只剔除一次", () => {
    const result = prefilterSubAgents(candidates, "code-reviewer", "code-reviewer");
    expect(result.map(d => d.function!.name)).toEqual(["general_assistant", "deployer"]);
  });
});

describe("prefilterSkillTools", () => {
  const candidates = ["readFile", "exec", "call_skill_sub_agent", "load_skill"];

  it("剔除 call_skill_sub_agent 和 load_skill", () => {
    expect(prefilterSkillTools(candidates)).toEqual(["readFile", "exec"]);
  });

  it("没有递归工具 — 原样返回", () => {
    expect(prefilterSkillTools(["readFile", "exec"])).toEqual(["readFile", "exec"]);
  });
});
