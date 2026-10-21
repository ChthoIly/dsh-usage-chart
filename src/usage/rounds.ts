/**
 * RoundFold（host 半区，深模块）：把会话事件流折叠为每轮用量明细。
 *
 * 小接口：`foldRounds(events, resolvePricing?) → { totals, rounds }`。
 * 大实现：四桶 token 折叠（与 token-meter 语义一致）+ 轮次耗时
 * （turn/start → turn/end）+ TTFT（turn/start → 首个输出样本）+
 * 输出吞吐（outputTokens / 输出时长）+ 模型归因（request/context 优先、
 * request/header 回退、跨轮携带回退）+ 结束原因 + 每轮成本分拆。
 *
 * 跨版本事件词汇：0.1.x 的流式用量走 `assistant/chunk`，0.2.x 移除了该事件，
 * 用量与流内时间线合并进 `assistant/message`（`usage` + `stream`）。这里优先用
 * `stream` 的首/末时间戳计算 TTFT 与 TPS（0.2.x），流时间线缺席时回退到首个
 * usage 样本 / turn 结束时刻（0.1.x 及旧日志）。`user/message.source` 在 0.1.x
 * 是字符串，0.2.x 是 `{ kind }` 对象，两者都归一为归因字符串。
 *
 * 纯函数：不读文件、不发起请求；价格来源经 `resolvePricing` 注入
 * （接缝），默认用内置刊例价。测试喂合成事件流即可断言全部字段。
 */
import type { CostSplit, TokenUsageBuckets } from '../pricing/calc.ts'
import { costSplitAt, ZERO_BUCKETS } from '../pricing/calc.ts'
import type { PricingResolver } from '../pricing/resolve.ts'
import { createPricingResolver } from '../pricing/resolve.ts'

/** 会话日志事件的最小形状（与 @deepseek-ai/dsh-session 的 SessionEvent 一致）。 */
export interface SessionEventLike {
  type: string
  seq: number
  /** Unix epoch 毫秒。 */
  time: number
  data: {
    turn?: number
    step?: number
    reason?: unknown
    provider?: string
    model?: string
    contextWindow?: number
    /** 0.1.x 是来源字符串；0.2.x 是携带 `kind` 的对象。 */
    source?: string | { kind?: string }
    header?: { config?: { provider?: string; model?: string }; source?: string }
    chunk?: { type?: string; usage?: unknown }
    usage?: unknown
    /** 0.2.x `assistant/message` 内嵌的流式时间线（绝对时间 + dt 增量编码）。 */
    stream?: unknown
  }
}

/** 每轮成本分拆（双币种：官方 CNY 与 USD 刊例价各一份）+ 来源/时效/未知标注。 */
export interface RoundCost {
  /** 人民币分拆（官方 CNY 价） */
  cny: CostSplit
  /** 美元分拆（官方 USD 价） */
  usd: CostSplit
  /** 是否使用了回退估算价（模型未收录）。 */
  estimated: boolean
  /** 模型是否被显式定价；false = 未定价模型。 */
  unknownModel: boolean
  /** 价格命中来源。 */
  source: 'file' | 'builtin' | 'fallback'
  /** 条目核验时间（epoch 毫秒），未知为 null。 */
  verifiedAt: number | null
}

/** 一轮的完整折叠结果。 */
export interface UsageRound {
  turn: number
  buckets: TokenUsageBuckets
  /** 归因模型（request/context → request/header → 跨轮携带回退；均无则 null）。 */
  model: string | null
  /** turn/start 时间（epoch 毫秒）。 */
  startedAt: number | null
  /** turn/end 时间（epoch 毫秒）。 */
  endedAt: number | null
  /** 总耗时（ms），端点缺失为 null。 */
  durationMs: number | null
  /** TTFT（ms）：turn/start → 首个 usage 样本。 */
  ttftMs: number | null
  /** 输出吞吐（tokens/s）：outputTokens / 输出时长。 */
  outputTps: number | null
  /** turn/end.reason.kind；未结束为 null。 */
  endReason: string | null
  /** 用户输入来源归因（'human' | 'agent.inject' | 'agent-message' 等；缺省为 null）。 */
  userSource: string | null
  cost: RoundCost
}
export interface FoldResult {
  totals: TokenUsageBuckets
  rounds: UsageRound[]
}

function zeroBuckets(): TokenUsageBuckets {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addInto(target: TokenUsageBuckets, other: TokenUsageBuckets): void {
  target.uncachedInputTokens += other.uncachedInputTokens
  target.outputTokens += other.outputTokens
  target.cacheReadTokens += other.cacheReadTokens
  target.cacheWriteTokens += other.cacheWriteTokens
}

function anyTokens(b: TokenUsageBuckets): boolean {
  return b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens > 0
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function bucketsOf(usage: unknown): TokenUsageBuckets | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage as Record<string, unknown>
  const inputTokens = tokenCount(value.inputTokens)
  const outputTokens = tokenCount(value.outputTokens)
  const cacheReadTokens = value.cacheReadTokens === undefined ? 0 : tokenCount(value.cacheReadTokens)
  const cacheWriteTokens = value.cacheWriteTokens === undefined ? 0 : tokenCount(value.cacheWriteTokens)
  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) return null
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

interface TurnState {
  start: number | null
  end: number | null
  endReason: string | null
  model: string | null
  /** 首个 usage 样本的时间（0.1.x TTFT 右端点）。 */
  firstUsageAt: number | null
  /** `assistant/message.stream` 时间线的最早输出时间（0.2.x TTFT 右端点，优先）。 */
  firstOutputAt: number | null
  /** `assistant/message.stream` 时间线的最晚输出时间（0.2.x TPS 右端点，优先）。 */
  outputEndAt: number | null
  buckets: TokenUsageBuckets
  userSource: string | null
}

/**
 * 从 0.2.x `assistant/message.stream` 提取首/末输出时间。
 * 时间线条目有两种形态：带绝对 `time` 的 chunk/block 边界，以及带 `time0` 与
 * `dt`（逐 chunk 毫秒增量数组）的增量编码；两者都参与取最早/最晚时间。
 * @param stream - 未知形状的流时间线（只在数组时解析）。
 * @returns 最早与最晚输出时间；无可用时间戳时为 null。
 */
function streamWindow(stream: unknown): { firstAt: number | null; lastAt: number | null } {
  if (!Array.isArray(stream)) return { firstAt: null, lastAt: null }
  let firstAt: number | null = null
  let lastAt: number | null = null
  const observe = (time: number): void => {
    if (!Number.isFinite(time)) return
    if (firstAt === null || time < firstAt) firstAt = time
    if (lastAt === null || time > lastAt) lastAt = time
  }
  for (const item of stream) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { time?: unknown; time0?: unknown; dt?: unknown }
    if (typeof record.time === 'number') observe(record.time)
    if (typeof record.time0 === 'number') {
      observe(record.time0)
      if (Array.isArray(record.dt)) {
        let span = 0
        let valid = true
        for (const delta of record.dt) {
          if (typeof delta !== 'number' || !Number.isFinite(delta)) { valid = false; break }
          span += delta
        }
        if (valid && span >= 0) observe(record.time0 + span)
      }
    }
  }
  return { firstAt, lastAt }
}

/**
 * 归一用户输入来源：0.1.x 字符串原样保留；0.2.x 对象取 `kind`；
 * 都缺席时按历史行为回退 'human'。
 */
function userSourceOf(data: SessionEventLike['data']): string | null {
  if (typeof data.source === 'string' && data.source !== '') return data.source
  if (typeof data.source === 'object' && data.source !== null) {
    const kind = data.source.kind
    if (typeof kind === 'string' && kind !== '') return kind
  }
  return typeof data.header?.source === 'string' && data.header.source !== '' ? data.header.source : 'human'
}

function turnReasonOf(reason: unknown): string | null {
  if (typeof reason === 'string' && reason !== '') return reason
  if (typeof reason === 'object' && reason !== null) {
    const kind = (reason as { kind?: unknown }).kind
    if (typeof kind === 'string' && kind !== '') return kind
  }
  return null
}

/**
 * 从会话日志折叠每轮用量（权威基准；client 观测只做实时指示，不合并）。
 *
 * 折叠语义（与 token-meter 一致）：
 *  - 用量来自 `assistant/chunk`（chunk.type === 'usage'）与 `assistant/message`；
 *  - 同一 (turn, step) 的重复样本替换而不是累加（chunk 早样 → message 终样）；
 *  - 步骤按日志顺序推进（不变量：后续步骤不会回补更早步骤的用量）。
 *
 * 时序字段只统计有用量样本的轮次；端点缺失（如当前未结束轮）对应字段为 null。
 *
 * @param events - 会话日志事件（按 seq 升序）。
 * @param resolvePricing - 价格解析注入点（接缝）；缺省用内置刊例价。
 */
export function foldRounds(events: readonly SessionEventLike[], resolvePricing?: PricingResolver): FoldResult {
  const resolver = resolvePricing ?? createPricingResolver()
  const totals = zeroBuckets()
  const states = new Map<number, TurnState>()
  let openTurn: number | null = null
  let openStepTurn: number | null = null
  /** 跨轮携带回退：最近一次出现的模型。 */
  let carryModel: string | null = null

  // token 折叠状态（沿用 v0.1 foldTurnUsage 的 step 替换语义）。
  let currentKey = ''
  let currentTurn = -1
  let stepBuckets: TokenUsageBuckets | null = null

  const stateFor = (turn: number): TurnState => {
    const existing = states.get(turn)
    if (existing !== undefined) return existing
    const created: TurnState = { start: null, end: null, endReason: null, model: null, firstUsageAt: null, firstOutputAt: null, outputEndAt: null, buckets: zeroBuckets(), userSource: null }
    states.set(turn, created)
    return created
  }
  const commitStep = (turn: number, buckets: TokenUsageBuckets): void => {
    addInto(stateFor(turn).buckets, buckets)
    addInto(totals, buckets)
  }
  const recordUsageAt = (turn: number, time: number): void => {
    const state = states.get(turn)
    if (state === undefined) return
    if (state.firstUsageAt === null || time < state.firstUsageAt) state.firstUsageAt = time
  }

  const attributeModel = (model: string | null): void => {
    if (model === null || model === undefined || model.trim() === '') return
    const normalized = model.trim()
    carryModel = normalized
    const target = openStepTurn ?? openTurn
    if (target !== null) {
      const state = states.get(target)
      if (state !== undefined && state.model === null) state.model = normalized
    }
  }

  for (const event of events) {
    const { type, data, time } = event
    switch (type) {
      case 'turn/start': {
        const turn = data.turn ?? -1
        openTurn = turn
        const state = stateFor(turn)
        if (state.start === null) state.start = time
        break
      }
      case 'turn/end': {
        const turn = data.turn ?? -1
        const state = states.get(turn)
        if (state !== undefined) {
          state.end = time
          state.endReason = turnReasonOf(data.reason)
          if (state.model === null) state.model = carryModel
        }
        openTurn = null
        openStepTurn = null
        break
      }
      case 'step/start': {
        openStepTurn = data.turn ?? null
        break
      }
      case 'request/context': {
        attributeModel(data.model ?? null)
        break
      }
      case 'request/header': {
        attributeModel(data.header?.config?.model ?? null)
        break
      }
      case 'user/message': {
        const targetTurn = openStepTurn ?? openTurn ?? data.turn
        if (targetTurn !== undefined && targetTurn !== null) {
          const state = stateFor(targetTurn)
          if (state.userSource === null) state.userSource = userSourceOf(data)
        }
        break
      }
      default: {
        // 0.2.x：流式时间线内嵌在 assistant/message.stream 中，先记录首/末输出时间。
        if (type === 'assistant/message' && data.turn !== undefined) {
          const window = streamWindow(data.stream)
          if (window.firstAt !== null || window.lastAt !== null) {
            const state = stateFor(data.turn)
            if (window.firstAt !== null && (state.firstOutputAt === null || window.firstAt < state.firstOutputAt)) state.firstOutputAt = window.firstAt
            if (window.lastAt !== null && (state.outputEndAt === null || window.lastAt > state.outputEndAt)) state.outputEndAt = window.lastAt
          }
        }
        let usage: unknown
        let turn: number | undefined
        let step: number | undefined
        if (type === 'assistant/chunk' && data.chunk?.type === 'usage') {
          ;({ turn, step } = data)
          usage = data.chunk.usage
        } else if (type === 'assistant/message' && data.usage !== undefined) {
          ;({ turn, step } = data)
          usage = data.usage
        }
        if (usage === undefined || turn === undefined || step === undefined) continue
        const sample = bucketsOf(usage)
        if (sample === null) continue
        const key = `${turn}:${step}`
        if (currentKey !== key) {
          if (stepBuckets !== null) commitStep(currentTurn, stepBuckets)
          currentKey = key
          currentTurn = turn
          stepBuckets = zeroBuckets()
        }
        stepBuckets = sample
        recordUsageAt(turn, time)
      }
    }
  }
  if (stepBuckets !== null) commitStep(currentTurn, stepBuckets)

  // 未结束的最后一轮：模型回退到最近出现的模型。
  if (openTurn !== null) {
    const state = states.get(openTurn)
    if (state !== undefined && state.model === null) state.model = carryModel
  }

  const rounds: UsageRound[] = []
  for (const [turn, state] of states) {
    if (!anyTokens(state.buckets)) continue
    const model = state.model ?? carryModel
    const durationMs = state.start !== null && state.end !== null ? state.end - state.start : null
    // 0.2.x 优先用流时间线首/末时间；旧日志回退到首个 usage 样本 / turn 结束时刻。
    const outputStart = state.firstOutputAt ?? state.firstUsageAt
    const outputEnd = state.outputEndAt ?? state.end
    const ttftMs = state.start !== null && outputStart !== null ? outputStart - state.start : null
    const outputTps =
      state.buckets.outputTokens > 0 && outputStart !== null && outputEnd !== null && outputEnd > outputStart
        ? state.buckets.outputTokens / ((outputEnd - outputStart) / 1_000)
        : null
    const resolved = resolver.resolve(model)
    // 按轮次开始时刻推断高峰/空闲时段计费；时刻缺失（无 turn/start）时按高峰保守估算。
    // 双币种各算一份（官方 CNY / USD 刊例价），client 按显示币种选用。
    const cny = costSplitAt(state.buckets, resolved.pricing, state.start ?? state.end, 'cny')
    const usd = costSplitAt(state.buckets, resolved.pricing, state.start ?? state.end, 'usd')
    const cost: RoundCost = {
      cny,
      usd,
      estimated: resolved.estimated,
      unknownModel: !resolved.known,
      source: resolved.source,
      verifiedAt: resolved.verifiedAt,
    }
    rounds.push({
      turn,
      buckets: { ...state.buckets },
      model,
      startedAt: state.start,
      endedAt: state.end,
      durationMs,
      ttftMs,
      outputTps,
      endReason: state.endReason,
      userSource: state.userSource,
      cost,
    })
  }
  rounds.sort((a, b) => a.turn - b.turn)

  return { totals, rounds }
}

/**
 * v0.1 兼容出口：仅折叠四桶（语义与 foldRounds 一致，不做时序/模型/成本）。
 * 新代码请用 foldRounds。
 */
export function foldTurnUsage(events: readonly SessionEventLike[]): {
  totals: TokenUsageBuckets
  turns: Array<{ turn: number; buckets: TokenUsageBuckets }>
} {
  const { totals, rounds } = foldRounds(events)
  return {
    totals,
    turns: rounds.map((round) => ({ turn: round.turn, buckets: round.buckets })),
  }
}
