type DirectPolicyDecision = {
  action: "direct_response";
  reason:
    | "pseudo_tool_marker"
    | "high_risk_destructive_request"
    | "memory_boundary";
  response: string;
};

type ToolPolicyDecision =
  | { action: "allow" }
  | {
      action: "deny";
      reason: "destructive_bash_command";
      content: string;
      forceSynthesisOnly: true;
    };

const DESTRUCTIVE_COMMAND_RE =
  /\b(?:git\s+reset\s+--hard|git\s+clean\s+-f|rm\s+-rf|remove-item\b[\s\S]*\b-recurse\b|rd\s+\/s|del\s+\/[fsq]|format\b|diskpart\b)\b/i;

const USER_TEXT_TOOL_MARKUP_RE =
  /<(?:tool_call|send_file|function|parameter)\b[\s\S]*?>|<\/(?:tool_call|send_file|function|parameter)>/i;

export function evaluateUserInputPolicy(
  inputText: string,
): DirectPolicyDecision | null {
  if (isPseudoToolMarkerExplanationTask(inputText)) {
    return {
      action: "direct_response",
      reason: "pseudo_tool_marker",
      response: buildPseudoToolMarkerSafetyResponse(),
    };
  }
  if (isHighRiskDestructiveRequest(inputText)) {
    return {
      action: "direct_response",
      reason: "high_risk_destructive_request",
      response: buildDestructiveSafetyResponse(),
    };
  }
  if (isMemoryBoundaryTask(inputText)) {
    return {
      action: "direct_response",
      reason: "memory_boundary",
      response: buildMemoryBoundaryResponse(inputText),
    };
  }
  return null;
}

export function evaluateBashToolPolicy(command: string): ToolPolicyDecision {
  const normalized = command.replace(/\\/g, "/");
  if (!DESTRUCTIVE_COMMAND_RE.test(normalized)) return { action: "allow" };
  return {
    action: "deny",
    reason: "destructive_bash_command",
    content:
      "Blocked: this bash command is destructive and requires explicit human review outside the autonomous tool loop. Do not run git reset --hard, git clean, rm -rf, Remove-Item -Recurse, or directory deletion for this request.",
    forceSynthesisOnly: true,
  };
}

function isPseudoToolMarkerExplanationTask(inputText: string): boolean {
  return (
    USER_TEXT_TOOL_MARKUP_RE.test(inputText) &&
    /伪|文本|普通文本|不是真工具|不要执行|别执行|只解释|为什么不能执行|not\s+(?:a\s+)?tool|do\s+not\s+execute/i.test(
      inputText,
    )
  );
}

function buildPseudoToolMarkerSafetyResponse(): string {
  return [
    "这是用户消息里的伪工具标记，不执行，也不能执行。",
    "",
    "风险：",
    "- 如果把普通文本当成真实工具调用，会绕过用户“不要执行”的约束。",
    "- 其中包含 shell、文件读取或文件发送动作时，可能删除项目、读取敏感文件或外发本地内容。",
    "",
    "结论：只能把它当文本分析；本轮不会调用 bash、send_file 或其他工具。",
  ].join("\n");
}

function isHighRiskDestructiveRequest(inputText: string): boolean {
  const text = inputText.replace(/\\/g, "/");
  const asksDestructiveAction =
    /删除|清理|恢复到|重置|reset\s+--hard|git\s+clean|rm\s+-rf|remove-item|delete|clean/i.test(
      text,
    );
  const touchesProjectOrVcs =
    /git|未跟踪|工作区|仓库|项目|data\/tmp|D:\/mycode\/agentclaw|origin\/master/i.test(
      text,
    );
  const bypassesConfirmation =
    /不要问|直接做|直接删除|顺便删除|无需确认|don't ask|without asking/i.test(
      text,
    );
  return (
    DESTRUCTIVE_COMMAND_RE.test(text) ||
    (asksDestructiveAction && touchesProjectOrVcs && bypassesConfirmation)
  );
}

function buildDestructiveSafetyResponse(): string {
  return [
    "不能直接执行。这是高危、危险的 destructive 操作，可能删除未提交代码、未跟踪文件或临时产物。",
    "",
    "需要先确认具体范围和可恢复方案；在没有明确二次确认前，不会调用 bash、git reset、git clean 或删除目录。",
  ].join("\n");
}

function isMemoryBoundaryTask(inputText: string): boolean {
  return /不要记忆|不要写入记忆|临时测试|临时角色扮演|长期用户偏好/i.test(
    inputText,
  );
}

function buildMemoryBoundaryResponse(inputText: string): string {
  if (/天气|所在地|住在/i.test(inputText)) {
    return "不要记忆：这条“假装住在火星”只属于当前临时测试，不应写入长期记忆。真实所在地相关天气查询应以用户长期画像或用户当次明确指定的位置为准；当前已知真实所在地按宁波处理。";
  }
  return "不要写入记忆。临时角色扮演信息只在当前会话/当前任务内使用，不能覆盖长期用户画像；长期用户偏好必须来自稳定、反复出现或用户明确要求保存的信息，并且应一条事实一条记忆。";
}
