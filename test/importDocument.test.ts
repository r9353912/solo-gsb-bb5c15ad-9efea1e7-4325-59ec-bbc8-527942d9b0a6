import assert from 'node:assert'
import {
  validateImportFile,
  validateImportedAnnotations,
} from '../src/lib/importDocument'
import type { ExportPayload } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const TEXT = '零一二三四五六七八九' // 10 个字符

function bound(id: string, start: number, end: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: 'bound',
    quote: TEXT.slice(start, end),
    note: '',
    tags: [],
    position: { start, end },
    context: { before: '', after: '' },
    pendingReason: null,
    lastRelocation: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

function pending(id: string, quote = '消失的引文') {
  return {
    id,
    status: 'pending',
    quote,
    note: '',
    tags: ['待办'],
    position: null,
    context: { before: '', after: '' },
    pendingReason: '原文中已找不到该引文',
    lastRelocation: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function payload(annotations: unknown[], extra: Partial<ExportPayload> = {}): ExportPayload {
  return {
    format: 'anchor-annotation-console',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    document: { title: '校验文档', text: TEXT, annotationCount: annotations.length },
    conflictRules: [],
    ignoredConflicts: [],
    coverageTags: [],
    baseline: null,
    reviewedDiffs: [],
    sampleConfig: null,
    sampleReviews: [],
    relations: [],
    relationCardinalityRules: [],
    annotations: annotations as ExportPayload['annotations'],
    ...extra,
  }
}

// ---------- 合法文件 ----------

check('合法导出文件（bound + pending 混合）通过校验并解析', () => {
  const result = validateImportFile(payload([bound('a1', 0, 2), pending('p1'), bound('a2', 5, 8)]))
  assert.deepStrictEqual(result.errors, [])
  assert.strictEqual(result.annotations.length, 3)
  assert.deepStrictEqual(
    result.annotations.map((a) => [a.id, a.status, a.start, a.end, a.quote]),
    [
      ['a1', 'bound', 0, 2, '零一'],
      ['p1', 'pending', 0, 0, '消失的引文'],
      ['a2', 'bound', 5, 8, '五六七'],
    ],
  )
  assert.deepStrictEqual(result.annotations[1]!.tags, ['待办'])
})

check('空标注数组（旧版 / 空文档导出）合法', () => {
  const result = validateImportFile(payload([]))
  assert.deepStrictEqual(result.errors, [])
  assert.deepStrictEqual(result.annotations, [])
})

check('旧版缺省可选分区的文件仍可导入（顶层只有必要字段）', () => {
  const minimal = {
    format: 'anchor-annotation-console',
    document: { title: '旧文件', text: TEXT },
    annotations: [bound('a1', 0, 1)],
  }
  const result = validateImportFile(minimal)
  assert.deepStrictEqual(result.errors, [])
  assert.strictEqual(result.annotations[0]!.id, 'a1')
})

check('半开区间边界 [0, 全文长度) 合法', () => {
  const result = validateImportedAnnotations([bound('a', 0, TEXT.length)], TEXT)
  assert.deepStrictEqual(result.errors, [])
  assert.strictEqual(result.annotations[0]!.quote, TEXT)
})

// ---------- 顶层结构 ----------

check('format 不对 → 拒绝且不解析标注', () => {
  const result = validateImportFile({ ...payload([]), format: 'something-else' })
  assert.strictEqual(result.annotations.length, 0)
  assert.ok(result.errors.some((m) => m.includes('无法识别')))
})

check('缺少原文 document.text → 拒绝', () => {
  const p = payload([]) as unknown as Record<string, unknown>
  delete (p as { document?: unknown }).document
  const result = validateImportFile(p)
  assert.ok(result.errors.some((m) => m.includes('document.text')))
})

check('annotations 不是数组 → 拒绝', () => {
  const result = validateImportedAnnotations({ not: 'array' }, TEXT)
  assert.strictEqual(result.annotations.length, 0)
  assert.strictEqual(result.errors[0]!.index, -1)
  assert.ok(result.errors[0]!.message.includes('annotations 不是数组'))
})

// ---------- ID 校验 ----------

check('ID 为空 / 非字符串 → 指出序号并拒绝整次导入', () => {
  const result = validateImportFile(
    payload([bound('', 0, 1), { ...bound('x', 0, 1), id: 42 }]),
  )
  assert.strictEqual(result.annotations.length, 0)
  assert.ok(result.errors.some((m) => m.startsWith('第 1 条标注：') && m.includes('ID 为空')))
  assert.ok(result.errors.some((m) => m.startsWith('第 2 条标注：') && m.includes('非空字符串')))
})

check('两条标注共用 ID → 重复者指出序号与首现位置，整次拒绝', () => {
  const result = validateImportFile(
    payload([bound('dup', 0, 1), bound('other', 1, 2), bound('dup', 2, 3)]),
  )
  assert.strictEqual(result.annotations.length, 0, '任一不合格必须拒绝整次导入')
  assert.strictEqual(result.errors.length, 1)
  assert.ok(result.errors[0]!.startsWith('第 3 条标注：'))
  assert.ok(result.errors[0]!.includes('与第 1 条记录重复'))
  assert.ok(result.errors[0]!.includes('dup'))
})

check('记录不是对象 → 指出序号', () => {
  const result = validateImportedAnnotations([null, 'str', bound('a', 0, 1)], TEXT)
  assert.deepStrictEqual(result.errors.map((e) => e.index), [0, 1])
  assert.ok(result.errors.every((e) => e.message.includes('不是有效的标注记录')))
})

// ---------- 区间校验（已绑定） ----------

check('bound 缺少 position → 拒绝并指出序号', () => {
  const result = validateImportFile(payload([{ ...bound('a', 0, 1), position: null }]))
  assert.strictEqual(result.annotations.length, 0)
  assert.ok(result.errors[0]!.includes('第 1 条标注：'))
  assert.ok(result.errors[0]!.includes('缺少区间'))
})

check('区间不是整数（1.5 / 字符串）→ 拒绝', () => {
  const result = validateImportFile(
    payload([{ ...bound('a', 0, 1), position: { start: 0.5, end: 2 } },
      { ...bound('b', 0, 1), position: { start: '0', end: 1 } }]),
  )
  assert.ok(result.errors.some((m) => m.includes('不是整数半开区间') && m.includes('start=0.5')))
  assert.ok(result.errors.some((m) => m.includes('start="0"')))
})

check('区间超出原文（负起点 / 终点超长）→ 拒绝并给出原文长度', () => {
  const result = validateImportFile(
    payload([{ ...bound('a', 0, 1), position: { start: -1, end: 1 } },
      { ...bound('b', 0, 1), position: { start: 9, end: 11 } }]),
  )
  assert.ok(result.errors.some((m) => m.includes('超出原文范围') && m.includes('[-1, 1)')))
  assert.ok(result.errors.some((m) => m.includes('[9, 11)') && m.includes('原文长度 10')))
})

check('空区间 start >= end（含 [2,2)）→ 拒绝', () => {
  const result = validateImportFile(
    payload([{ ...bound('a', 0, 1), position: { start: 3, end: 3 } },
      { ...bound('b', 0, 1), position: { start: 5, end: 2 } }]),
  )
  assert.ok(result.errors.some((m) => m.includes('[3, 3)') && m.includes('为空')))
  assert.ok(result.errors.some((m) => m.includes('[5, 2)')))
})

check('区间文字与引文不符 → 拒绝并同时展示原文片段与引文', () => {
  const result = validateImportFile(
    payload([{ ...bound('a', 0, 2), quote: '错误引文' }]),
  )
  assert.strictEqual(result.annotations.length, 0)
  assert.ok(result.errors[0]!.includes('区间文字与引文不符'))
  assert.ok(result.errors[0]!.includes('「零一」'))
  assert.ok(result.errors[0]!.includes('「错误引文」'))
})

check('引文不是字符串 → 拒绝', () => {
  const result = validateImportFile(
    payload([{ ...bound('a', 0, 1), quote: 42 }]),
  )
  assert.ok(result.errors[0]!.includes('引文 quote 不是字符串'))
})

check('同区间合法但位置漂移到同文副本以外的文字 → 按不符拒绝（不靠引文搜索兜底）', () => {
  const text2 = '甲乙甲乙' // 「甲乙」在 0 和 2
  const a = { ...bound('x', 0, 2), quote: '甲乙' }
  const shifted = { ...a, position: { start: 1, end: 3 } } // [1,3) 是「乙甲」
  const result = validateImportedAnnotations([shifted], text2)
  assert.strictEqual(result.errors.length, 1)
  assert.ok(result.errors[0]!.message.includes('区间文字与引文不符'))
})

// ---------- pending ----------

check('pending 标注 position 为 null → 合法，区间落为 0/0', () => {
  const result = validateImportedAnnotations([pending('p')], TEXT)
  assert.deepStrictEqual(result.errors, [])
  assert.strictEqual(result.annotations[0]!.status, 'pending')
  assert.strictEqual(result.annotations[0]!.start, 0)
  assert.strictEqual(result.annotations[0]!.end, 0)
})

check('pending 标注即便引文与任意原文不一致也不校验区间', () => {
  const result = validateImportedAnnotations([pending('p', '完全不存在的引文XYZ')], TEXT)
  assert.deepStrictEqual(result.errors, [])
})

// ---------- 原子性与字段映射 ----------

check('合法记录解析：时间戳、状态、上下文与备注完整映射', () => {
  const a = {
    ...bound('ann', 2, 4, {
      note: '备注',
      tags: ['标签一', '标签二'],
      context: { before: '前文', after: '后文' },
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: 'not-a-date',
    }),
  }
  const result = validateImportedAnnotations([a], TEXT)
  assert.deepStrictEqual(result.errors, [])
  const got = result.annotations[0]!
  assert.strictEqual(got.quote, '二三')
  assert.strictEqual(got.note, '备注')
  assert.deepStrictEqual(got.tags, ['标签一', '标签二'])
  assert.strictEqual(got.contextBefore, '前文')
  assert.strictEqual(got.contextAfter, '后文')
  assert.strictEqual(got.createdAt, Date.parse('2026-03-01T00:00:00.000Z'))
  assert.ok(Number.isFinite(got.updatedAt), '非法时间回退为当前时间')
})

check('多条错误一次性全部报出（序号各不相同），且不返回任何标注', () => {
  const result = validateImportFile(
    payload([
      bound('dup', 0, 1),
      bound('dup', 1, 2),
      { ...bound('c', 0, 1), quote: '不符' },
    ]),
  )
  assert.strictEqual(result.annotations.length, 0)
  assert.ok(result.errors.some((m) => m.startsWith('第 2 条标注：')))
  assert.ok(result.errors.some((m) => m.startsWith('第 3 条标注：')))
})

check('代理对文字按 JS 字符串下标（码元）切片一致即合法，与正文渲染口径相同', () => {
  const text = '😀😁😂😃😄'
  const a = {
    id: 'emoji',
    status: 'bound',
    quote: '😁😂',
    note: '',
    tags: [],
    position: { start: 2, end: 6 },
    context: { before: '', after: '' },
    pendingReason: null,
    lastRelocation: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const result = validateImportedAnnotations([a], text)
  assert.deepStrictEqual(result.errors.map((e) => e.message), [])
  assert.strictEqual(result.annotations[0]!.quote, '😁😂')
})

console.log(`\n导入校验测试通过（${passed} 项）`)
