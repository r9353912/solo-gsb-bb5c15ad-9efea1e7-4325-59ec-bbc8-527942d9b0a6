// JSON 导入：标注数组的完整校验与文档构建
//
// 侧栏、关系、快照、抽样等模块都以标注 ID 作为关联键做 Map 查找，
// 原文定位与覆盖审计则直接信任已绑定标注的 [start, end) 区间。
// 因此导入在写入文档前必须逐条校验：
//   1. 标注 ID 为非空字符串，且在 annotations 数组内全局唯一；
//   2. 已绑定（status === 'bound'）标注的区间为原文内的非空整数半开区间：
//      0 <= start < end <= text.length（start、end 均为安全整数）；
//   3. 已绑定标注的区间文字 text.slice(start, end) 与引文 quote 完全相等。
// 任一记录不合格：返回该记录在数组中的序号（从 1 开始）与原因，
// 调用方据此拒绝整次导入，当前文档及全部关联记录保持原样。
// 合法的当前导出文件与旧版缺省可选分区（冲突 / 覆盖 / 快照 / 抽样 / 关系 / 基数规则）
// 仍按既有归一规则无损导入。

import type { Annotation, DocumentData } from '../types'
import { normalizeIgnored, normalizeRules, pruneIgnored } from './conflicts'
import { normalizeCoverageTags } from './coverage'
import { normalizeBaseline, normalizeReviewedDiffs, pruneReviewedDiffs, diffSnapshot } from './snapshot'
import { normalizeSampleConfig, normalizeSampleReviews, pruneSampleReviews } from './sampling'
import { normalizeCardinalityRules, normalizeRelations } from './relations'

/** 一条不合格标注：index 为 annotations 数组中的序号（从 1 开始） */
export interface ImportAnnotationError {
  index: number
  reason: string
}

/** 顶层结构错误（无法识别为本工具的导出文件）；与逐条标注错误互斥 */
export type ImportParseResult =
  | { ok: true; document: DocumentData }
  | { ok: false; errors: ImportAnnotationError[]; formatError?: string }

/** 校验通过时构建出的原始标注（时间字段保持导出文件中的 ISO 字符串，由构建步骤解析） */
type RawAnnotation = Annotation

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

function parseTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return Date.now()
}

/** 引文超长时仅在错误提示中展示前缀，避免提示框过长 */
function previewQuote(quote: unknown): string {
  const s = typeof quote === 'string' ? quote : String(quote ?? '')
  return s.length > 20 ? `${s.slice(0, 20)}…` : s
}

/**
 * 校验并构建导入文档。
 * - 顶层结构无法识别（format / document.text / annotations 形态错误）：返回 formatError；
 * - 任一标注不合格：返回 errors（含序号与原因，可多条），不构建文档；
 * - 全部合法：返回完整 DocumentData，可选分区沿用旧版缺省归一规则。
 * 纯函数：不读取 / 不写入 localStorage，不修改传入的 payload。
 */
export function buildImportDocument(
  parsed: unknown,
  now: number = Date.now(),
): ImportParseResult {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: [], formatError: '文件不是有效的 JSON 对象。' }
  }
  const payload = parsed as Record<string, unknown>
  if (payload.format !== 'anchor-annotation-console') {
    return { ok: false, errors: [], formatError: '无法识别的文件格式，请选择本工具导出的 JSON。' }
  }
  const documentMeta = payload.document
  if (!documentMeta || typeof documentMeta !== 'object') {
    return { ok: false, errors: [], formatError: '缺少 document 分区，请选择本工具导出的 JSON。' }
  }
  const text = (documentMeta as Record<string, unknown>).text
  if (typeof text !== 'string') {
    return { ok: false, errors: [], formatError: 'document.text 缺失或不是字符串，无法核对标注区间。' }
  }
  const rawAnnotations = payload.annotations
  if (!Array.isArray(rawAnnotations)) {
    return { ok: false, errors: [], formatError: 'annotations 缺失或不是数组，请选择本工具导出的 JSON。' }
  }

  const errors: ImportAnnotationError[] = []
  const seenIds = new Set<string>()
  // 先完整收集错误，便于一次指出全部不合格记录（序号仍对应原数组）
  const records: { x: Record<string, unknown>; status: Annotation['status']; quoteOk: boolean }[] = []

  rawAnnotations.forEach((item, i) => {
    const index = i + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index, reason: '不是标注对象' })
      return
    }
    const x = item as Record<string, unknown>

    // 1. ID：非空字符串且全局唯一
    const id = x.id
    if (typeof id !== 'string' || id === '') {
      errors.push({ index, reason: '标注 ID 缺失或不是非空字符串' })
    } else if (seenIds.has(id)) {
      errors.push({ index, reason: `标注 ID「${id}」重复，ID 必须在 annotations 数组内全局唯一` })
    } else {
      seenIds.add(id)
    }

    // 状态归一：除明确的 pending 外按 bound 处理（与基线等归一入口口径一致）
    const status: Annotation['status'] = x.status === 'pending' ? 'pending' : 'bound'

    // 引文必须是字符串（区间文字核对的前提）
    const quoteOk = typeof x.quote === 'string'
    if (!quoteOk) {
      errors.push({ index, reason: '引文 quote 缺失或不是字符串' })
    }

    // 2/3. 已绑定标注：区间为原文内非空整数半开区间，且区间文字等于引文
    if (status === 'bound') {
      const position = x.position
      if (!position || typeof position !== 'object' || Array.isArray(position)) {
        errors.push({ index, reason: '已绑定标注缺少 position 区间（应为 { start, end }）' })
      } else {
        const p = position as Record<string, unknown>
        const start = p.start
        const end = p.end
        if (!isInt(start) || !isInt(end)) {
          errors.push({
            index,
            reason: `区间起止必须为整数，收到 start=${JSON.stringify(start)}、end=${JSON.stringify(end)}`,
          })
        } else if (start < 0 || end > text.length) {
          errors.push({
            index,
            reason: `区间 [${start}, ${end}) 超出原文范围（原文长度 ${text.length}）`,
          })
        } else if (start >= end) {
          errors.push({
            index,
            reason: `区间 [${start}, ${end}) 为空或方向颠倒，已绑定区间必须满足 start < end`,
          })
        } else if (quoteOk && text.slice(start, end) !== x.quote) {
          errors.push({
            index,
            reason: `区间 [${start}, ${end}) 的原文「${previewQuote(text.slice(start, end))}」与引文「${previewQuote(x.quote)}」不符`,
          })
        }
      }
    }

    records.push({ x, status, quoteOk })
  })

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // 全部合法：构建标注（旧版字段缺省在此无损补齐）
  const annotations: RawAnnotation[] = records.map(({ x, status }) => {
    const position = x.position as { start?: unknown; end?: unknown } | null | undefined
    const start = status === 'bound' && isInt(position?.start) ? (position!.start as number) : 0
    const end = status === 'bound' && isInt(position?.end) ? (position!.end as number) : 0
    const tags = Array.isArray(x.tags)
      ? x.tags.map(String).filter((t) => t !== '')
      : []
    const context = x.context && typeof x.context === 'object' && !Array.isArray(x.context)
      ? (x.context as Record<string, unknown>)
      : {}
    const lastRelocation =
      x.lastRelocation && typeof x.lastRelocation === 'object' && !Array.isArray(x.lastRelocation)
        ? (x.lastRelocation as Annotation['lastRelocation'])
        : undefined
    return {
      id: x.id as string,
      quote: x.quote as string,
      start,
      end,
      note: typeof x.note === 'string' ? x.note : '',
      tags,
      status,
      createdAt: parseTime(x.createdAt),
      updatedAt: parseTime(x.updatedAt),
      contextBefore: typeof context.before === 'string' ? context.before : '',
      contextAfter: typeof context.after === 'string' ? context.after : '',
      pendingReason:
        status === 'pending' && typeof x.pendingReason === 'string'
          ? x.pendingReason
          : undefined,
      lastRelocation,
    }
  })

  // ---------- 可选分区：合法的当前导出与旧版缺省文件均无损导入 ----------

  const conflictRules = normalizeRules(payload.conflictRules)
  const baselineRaw = payload.baseline
  const baseline =
    baselineRaw && typeof baselineRaw === 'object'
      ? normalizeBaseline({
          createdAt: (baselineRaw as Record<string, unknown>).createdAt,
          annotations: Array.isArray((baselineRaw as Record<string, unknown>).annotations)
            ? ((baselineRaw as Record<string, unknown>).annotations as unknown[]).map((b) => {
                const r = (b ?? {}) as Record<string, unknown>
                const pos = r.position as { start?: unknown; end?: unknown } | null | undefined
                return {
                  id: r.id,
                  status: r.status,
                  quote: r.quote,
                  note: r.note,
                  tags: r.tags,
                  start: pos?.start ?? 0,
                  end: pos?.end ?? 0,
                }
              })
            : [],
        })
      : null
  // 仅保留仍能命中导入后差异的已审记录
  const reviewedDiffs = pruneReviewedDiffs(
    normalizeReviewedDiffs(payload.reviewedDiffs),
    diffSnapshot(baseline, annotations),
  )
  // 仅保留引用的标注仍存在、仍已绑定且内容签名一致的复核结论
  const sampleReviews = pruneSampleReviews(
    normalizeSampleReviews(payload.sampleReviews),
    annotations,
  )

  const rawTitle = (documentMeta as Record<string, unknown>).title
  const document: DocumentData = {
    title: typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : '未命名文档',
    text,
    annotations,
    // 忽略记录引用已删标注 / 规则的在导入时剔除
    conflictRules,
    ignoredConflicts: pruneIgnored(
      normalizeIgnored(payload.ignoredConflicts),
      annotations,
      conflictRules,
    ),
    coverageTags: normalizeCoverageTags(payload.coverageTags),
    baseline,
    reviewedDiffs,
    sampleConfig: normalizeSampleConfig(payload.sampleConfig),
    sampleReviews,
    // 关系有效性由两端标注派生：引用缺失 / 待处理标注的关系保留为失效记录
    relations: normalizeRelations(payload.relations),
    relationCardinalityRules: normalizeCardinalityRules(payload.relationCardinalityRules),
    updatedAt: now,
  }
  return { ok: true, document }
}
