// JSON 导入校验：标注记录在写入文档前逐条完整校验。
//
// 侧栏、关系、快照、抽样与覆盖审计都按标注 ID 查找，区间则直接决定定位与覆盖审计指向的原文；
// 因此导入文件必须同时满足：
//   1. annotations 是数组（顶层结构由本工具导出，旧版缺省的可选分区在调用方按空补）；
//   2. 每条标注的 ID 为非空字符串，且在数组内全局唯一；
//   3. 已绑定（bound）标注的 position 是原文内的非空整数半开区间 [start, end)，
//      且 text.slice(start, end) 与引文 quote 逐字一致；
//   4. 待处理（pending）标注不携带区间（position 为 null），区间按 0/0 落库。
//
// 任一记录不合格：返回全部问题（含序号与原因），调用方据此拒绝整次导入，
// 当前文档与关联记录保持原样。

import type { Annotation, ExportPayload } from '../types'

/** 一条标注记录的校验错误：index 为 annotations 数组中的 0 基下标 */
export interface AnnotationImportError {
  index: number
  message: string
}

export interface ImportValidation {
  /** 校验通过时为解析后的标注数组（顺序与文件一致）；失败时为空数组 */
  annotations: Annotation[]
  /** 顶层结构错误（无前缀序号）与逐条标注错误（已带「第 N 条标注：」前缀） */
  errors: string[]
}

function parseTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return Date.now()
}

type RawAnnotation = ExportPayload['annotations'][number]

/**
 * 逐条校验并解析 annotations 数组。
 * 纯函数：不修改入参；返回的错误集与记录顺序一致，重复 ID 的问题挂在后出现的记录上。
 */
export function validateImportedAnnotations(
  raw: unknown,
  text: string,
): { annotations: Annotation[]; errors: AnnotationImportError[] } {
  const errors: AnnotationImportError[] = []
  const annotations: Annotation[] = []
  if (!Array.isArray(raw)) {
    return { annotations, errors: [{ index: -1, message: 'annotations 不是数组' }] }
  }

  const seenIds = new Map<string, number>()
  raw.forEach((x, i) => {
    const recordErrors: string[] = []
    if (!x || typeof x !== 'object') {
      errors.push({ index: i, message: '不是有效的标注记录（应为对象）' })
      return
    }
    const r = x as Partial<RawAnnotation>

    // 1) ID 必须是非空字符串且全局唯一
    const id = r.id
    if (typeof id !== 'string' || id === '') {
      recordErrors.push('标注 ID 为空或不是非空字符串')
    } else {
      const first = seenIds.get(id)
      if (first !== undefined) {
        recordErrors.push(`标注 ID「${id}」与第 ${first + 1} 条记录重复`)
      } else {
        seenIds.set(id, i)
      }
    }

    // 2) 已绑定标注：区间必须是原文内非空整数半开区间，且区间文字等于引文
    const status: Annotation['status'] = r.status === 'pending' ? 'pending' : 'bound'
    let start = 0
    let end = 0
    if (status === 'bound') {
      const pos = r.position
      if (!pos || typeof pos !== 'object') {
        recordErrors.push('已绑定标注缺少区间 position（应为 { start, end }）')
      } else {
        const s = (pos as { start?: unknown }).start
        const e = (pos as { end?: unknown }).end
        if (
          typeof s !== 'number' ||
          !Number.isInteger(s) ||
          typeof e !== 'number' ||
          !Number.isInteger(e)
        ) {
          recordErrors.push(
            `区间不是整数半开区间：start=${JSON.stringify(s)}、end=${JSON.stringify(e)}`,
          )
        } else if (s < 0 || e > text.length) {
          recordErrors.push(
            `区间 [${s}, ${e}) 超出原文范围（原文长度 ${text.length}）`,
          )
        } else if (s >= e) {
          recordErrors.push(`区间 [${s}, ${e}) 为空（半开区间须满足 start < end）`)
        } else {
          start = s
          end = e
          if (typeof r.quote !== 'string') {
            recordErrors.push('引文 quote 不是字符串')
          } else {
            const slice = text.slice(start, end)
            if (slice !== r.quote) {
              recordErrors.push(
                `区间文字与引文不符：[${start}, ${end}) 处原文为「${slice}」，引文为「${r.quote}」`,
              )
            }
          }
        }
      }
    }

    if (recordErrors.length > 0) {
      for (const message of recordErrors) errors.push({ index: i, message })
      return
    }

    annotations.push({
      id: id as string,
      quote: typeof r.quote === 'string' ? r.quote : '',
      start,
      end,
      note: typeof r.note === 'string' ? r.note : '',
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      status,
      createdAt: parseTime(r.createdAt),
      updatedAt: parseTime(r.updatedAt),
      contextBefore: typeof r.context?.before === 'string' ? r.context.before : '',
      contextAfter: typeof r.context?.after === 'string' ? r.context.after : '',
      pendingReason: typeof r.pendingReason === 'string' ? r.pendingReason : undefined,
      lastRelocation:
        r.lastRelocation && typeof r.lastRelocation === 'object'
          ? (r.lastRelocation as Annotation['lastRelocation'])
          : undefined,
    })
  })

  return { annotations: errors.length > 0 ? [] : annotations, errors }
}

/**
 * 校验已 JSON.parse 的导出文件：
 * 顶层格式可识别、原文为字符串，且全部标注记录通过逐条校验。
 * 旧版缺省的可选分区（冲突 / 覆盖 / 快照 / 抽样 / 关系 / 基数规则）不在此处拦截，
 * 由调用方的 normalize* 清洗按空补。
 */
export function validateImportFile(parsed: unknown): ImportValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { annotations: [], errors: ['文件内容不是有效的 JSON 对象'] }
  }
  const p = parsed as Partial<ExportPayload>
  if (p.format !== 'anchor-annotation-console') {
    return {
      annotations: [],
      errors: ['无法识别的文件格式（format 不是 "anchor-annotation-console"）'],
    }
  }
  if (!p.document || typeof p.document !== 'object' || typeof p.document.text !== 'string') {
    return { annotations: [], errors: ['缺少 document.text 原文（应为字符串）'] }
  }

  const { annotations, errors } = validateImportedAnnotations(p.annotations, p.document.text)
  return {
    annotations,
    errors: errors.map((e) =>
      e.index < 0 ? e.message : `第 ${e.index + 1} 条标注：${e.message}`,
    ),
  }
}
