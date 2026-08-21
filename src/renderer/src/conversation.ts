import type { AiMessage } from "./types";

// 会话详情中“一问一答”轮次的类型与构造逻辑（纯函数），从 App.tsx 抽出共享，
// 供详情弹框渲染与分支创建（branchFromTurn / getBranchMessageCount）共用。

export type ConversationMessageEntry = {
  message: AiMessage;
  index: number;
};

export type ConversationTurn = {
  user?: ConversationMessageEntry;
  replies: ConversationMessageEntry[];
};

export function buildConversationTurns(messages: AiMessage[], offset = 0) {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;

  messages.forEach((message, index) => {
    if (!isVisibleConversationMessage(message)) return;
    const entry = { message, index: offset + index };
    if (message.role === "user") {
      currentTurn = { user: entry, replies: [] };
      turns.push(currentTurn);
      return;
    }

    if (!currentTurn) {
      currentTurn = { replies: [] };
      turns.push(currentTurn);
    }

    currentTurn.replies.push(entry);
  });

  return turns.filter((turn) => turn.user || turn.replies.length > 0);
}

export function isVisibleConversationMessage(message: AiMessage) {
  if (message.text.includes("<turn_aborted>")) return false;
  if (message.text.includes("<permissions instructions>")) return false;
  return true;
}
