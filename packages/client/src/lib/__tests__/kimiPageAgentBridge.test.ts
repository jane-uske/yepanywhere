import { describe, expect, it } from "vitest";
import {
  type KimiPageAgentContext,
  buildKimiPageAgentPrompt,
} from "../kimiPageAgentBridge";

const context: KimiPageAgentContext = {
  page: {
    product: {
      key: "alimebot",
      name: "AlimeBot",
      codeGroup: "https://code.alibaba-inc.com/aidc-mefe",
    },
    shell: {
      origin: "https://pre-alimebot.sg.alibaba-inc.com",
      pathname: "/alime.htm",
      title: "AlimeBot Platform",
    },
  },
  selection: {
    element: {
      tag: "svg",
      attributes: {
        "data-icon": "setting",
      },
    },
    paths: {
      selector: "button svg[data-icon='setting']",
    },
  },
};

describe("buildKimiPageAgentPrompt", () => {
  it("keeps analysis-only instructions read-only", () => {
    const prompt = buildKimiPageAgentPrompt(context, "看下这个按钮的逻辑");

    expect(prompt).toContain("看下这个按钮的逻辑");
    expect(prompt).toContain("本次任务是只读分析");
    expect(prompt).toContain("不要修改、提交或部署任何代码");
    expect(prompt).toContain("页面产品分类为 AlimeBot");
    expect(prompt).not.toContain("完成修改");
    expect(prompt).not.toContain("建迭代、推进改动、提交和部署");
  });

  it("keeps explicit modification instructions in edit mode", () => {
    const prompt = buildKimiPageAgentPrompt(context, "把这个按钮隐藏掉");

    expect(prompt).toContain("把这个按钮隐藏掉");
    expect(prompt).toContain("定位仓库后按需要通过 o2 MCP 建迭代");
    expect(prompt).toContain("完成修改");
    expect(prompt).not.toContain("本次任务是只读分析");
  });
});
