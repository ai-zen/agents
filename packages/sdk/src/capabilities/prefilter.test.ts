import { describe, it, expect } from "vitest";
import { prefilterSubAgents, prefilterSkillTools } from "./prefilter";

describe("prefilterSubAgents", () => {
  const candidates = ["general_assistant", "code-reviewer", "deployer"];

  it("无自身无调用者 — 原样返回", () => {
    expect(prefilterSubAgents(candidates)).toEqual(candidates);
  });

  it("剔除自身", () => {
    expect(prefilterSubAgents(candidates, "code-reviewer")).toEqual([
      "general_assistant",
      "deployer",
    ]);
  });

  it("剔除调用者", () => {
    expect(
      prefilterSubAgents(candidates, undefined, "general_assistant"),
    ).toEqual(["code-reviewer", "deployer"]);
  });

  it("同时剔除自身和调用者", () => {
    expect(
      prefilterSubAgents(candidates, "code-reviewer", "general_assistant"),
    ).toEqual(["deployer"]);
  });

  it("自身和调用者同名 — 只剔除一次", () => {
    expect(
      prefilterSubAgents(candidates, "code-reviewer", "code-reviewer"),
    ).toEqual(["general_assistant", "deployer"]);
  });
});

describe("prefilterSkillTools", () => {
  const candidates = [
    "readFile",
    "exec",
    "call_skill_sub_agent",
    "load_skill",
  ];

  it("剔除 call_skill_sub_agent 和 load_skill", () => {
    expect(prefilterSkillTools(candidates)).toEqual(["readFile", "exec"]);
  });

  it("没有递归工具 — 原样返回", () => {
    expect(prefilterSkillTools(["readFile", "exec"])).toEqual([
      "readFile",
      "exec",
    ]);
  });
});
