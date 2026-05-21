import type { Message, ToolResult } from "@agentclaw/types";
import type { TaskToolProfile } from "../ability/task-router.js";

export type SentFile = { url: string; filename: string };

export type CompletionToolResult = {
  effectiveToolName: string;
  result: Pick<ToolResult, "content" | "isError" | "metadata">;
};

export type CompletionArtifact =
  | {
      kind: "send_existing_file";
      path: string;
      sendEffectSource: string;
    }
  | {
      kind: "write_and_send_markdown";
      filename: string;
      content: string;
      writeEffectSource: string;
      sendEffectSource: string;
    };

export type CompletionPolicyInput = {
  taskKind: TaskToolProfile["kind"];
  inputText: string;
  messages: Message[];
  sentFiles: SentFile[];
  fallbackSnippets: string[];
  currentResultContents: string[];
  toolResults: CompletionToolResult[];
  successfulWebSearchCalls: number;
  successfulWebFetchCalls: number;
  wantsFileDelivery: boolean;
  now?: Date;
};

export type CompletionPolicyDecision = {
  policyName: string;
  text: string;
  artifacts: CompletionArtifact[];
};

export type CompletionPolicy = {
  name: string;
  evaluate(input: CompletionPolicyInput): CompletionPolicyDecision | null;
};
