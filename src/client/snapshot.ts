/**
 * 客户端数据形状（自包含、与 DSH 0.1.x / 0.2.x web 运行时兼容的最小声明）。
 * 仅描述本插件实际读取的字段；真实类型来自平台：
 * 会话快照（ui-session）、chat 标准源（ui-chat）与
 * `@deepseek-ai/dsh-client-ui-conversation` 的 ConversationNode。
 *
 * 兼容性备注：
 *  - 0.1.x 的 assistant 节点用 `provenance` 上报稳定模型身份；
 *  - 0.2.x 改名为 `providerMetadata`（`provenance` 移除），
 *    `requestConfig`（provider/model）两个版本都有，作为最后回退。
 */

/** 会话 id（wire 上即字符串）。 */
export type SessionId = string

/** 会话快照中的节点（本插件只读取 kind/turn/模型身份/messageId 等字段）。 */
export interface ConversationNode {
  kind: string
  seq: number
  turn: number
  step?: number
  time?: number
  /** 完成请求的稳定模型身份（DSH 0.1.x adapter 上报字段）。 */
  provenance?: { provider: string; model: string }
  /** 完成请求的稳定模型身份（DSH 0.2.x 起替代 provenance）。 */
  providerMetadata?: { provider: string; model: string }
  requestConfig?: { provider?: string; model?: string }
  /** 稳定消息身份（assistant 节点；CostBadge 用 messageId → turn 归因）。 */
  messageId?: string
  blocks?: readonly unknown[]
  content?: readonly unknown[]
}

/**
 * 从节点推导模型名：0.1.x `provenance` → 0.2.x `providerMetadata` → `requestConfig`。
 * @param node - 会话节点（只有 assistant 节点携带模型身份）。
 * @returns 模型名；节点没有可用的模型身份时返回 undefined。
 */
export function nodeModelName(node: ConversationNode): string | undefined {
  if (node.provenance?.model !== undefined && node.provenance.model !== '') return node.provenance.model
  if (node.providerMetadata?.model !== undefined && node.providerMetadata.model !== '') return node.providerMetadata.model
  if (node.requestConfig?.model !== undefined && node.requestConfig.model !== '') return node.requestConfig.model
  return undefined
}

/**
 * 会话快照（ConversationSnapshot 的子集）。
 * 0.1.x 早期版本在 `chat.legacy.nodes` / 顶层 `nodes` 挂节点列表；
 * 0.2.x 会话快照不再携带节点（节点来自独立的 chat 标准源），旧路径仅作回退。
 */
export interface ConversationSnapshot {
  sessionId: SessionId
  /** 兼容字段：完整节点列表（含 user/assistant/tool 等）。 */
  nodes: readonly ConversationNode[]
  /** 0.1.x 实际填充节点列表的位置（官方 StatsLine 读这里）。 */
  chat: {
    legacy: {
      nodes: readonly ConversationNode[]
    }
  }
  running: boolean
  blank: boolean
  removed: boolean
  composerPhase: unknown
  [key: string]: unknown
}

/** chat 快照（0.1.2+ / 0.2.x 会话作用域标准源 'chat' 的形状，只取本插件需要的 legacy 切片）。 */
export interface ChatSnapshotLike {
  legacy?: { nodes?: readonly ConversationNode[] }
}

/** 标准源 hook（槽位套件把 'chat' 源包成 useChat 注入组件 props）。 */
export type ChatNodesHook = (selector: (snapshot: ChatSnapshotLike) => unknown) => unknown

export type SessionHook = <S>(selector: (snapshot: ConversationSnapshot) => S) => S

/** chat 源缺席时的占位实现（保持 Hook 调用顺序稳定）。 */
const NO_CHAT_NODES: ChatNodesHook = () => undefined
const EMPTY_NODES: readonly ConversationNode[] = []

/** 从快照取节点列表：优先 chat.legacy.nodes（0.1.x 实际路径），回退顶层 nodes。 */
export function snapshotNodes(snapshot: ConversationSnapshot): readonly ConversationNode[] {
  const legacy = snapshot.chat?.legacy?.nodes
  if (Array.isArray(legacy) && legacy.length > 0) return legacy
  return Array.isArray(snapshot.nodes) ? snapshot.nodes : EMPTY_NODES
}

/**
 * 读会话节点：0.1.2 起 chat 快照是独立标准源（props.useChat.legacy.nodes），
 * 不再挂在会话快照上；0.2.x 沿用同一路径（ChatSnapshot.legacy.nodes）。
 * 会话快照旧路径仅作回退（旧平台/旧快照）。
 */
export function useSessionNodes(useChat: ChatNodesHook | undefined, useSession: SessionHook): readonly ConversationNode[] {
  // 两个 hook 必须无条件按固定顺序调用：任一条路径少调一次会错位后续 hook 状态
  // （症状是 useMemo 的 prevDeps 变成 undefined，报 "reading 'length'"）。
  const fromChat = (useChat ?? NO_CHAT_NODES)((snapshot) => snapshot.legacy?.nodes)
  const fromSession = useSession(snapshotNodes)
  return Array.isArray(fromChat) && fromChat.length > 0 ? fromChat as readonly ConversationNode[] : fromSession
}
