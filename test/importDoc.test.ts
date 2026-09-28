import assert from 'node:assert'
import { buildImportDocument, type ImportAnnotationError } from '../src/lib/importDoc'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const TEXT = '零一二三四五六七八九' // 10 字

/** 构造一份合法导出 payload（结构与 App 导出一致） */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    format: 'anchor-annotation-console',
    version: 1,
    exportedAt: '2026-09-28T00:00:00.000Z',
    document: { title: '导入校验文档', text: TEXT, annotationCount: 2 },
    conflictRules: [],
    ignoredConflicts: [],
    coverageTags: [],
    baseline: null,
    reviewedDiffs: [],
    sampleConfig: null,
    sampleReviews: [],
    relations: [],
    relationCardinalityRules: [],
    annotations: [
      {
        id: 'a_one',
        status: 'bound',
        quote: TEXT.slice(0, 2),
        note: '',
        tags: ['甲'],
        position: { start: 0, end: 2 },
        context: { before: '', after: TEXT.slice(2) },
        pendingReason: null,
        lastRelocation: null,
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: 'a_two',
        status: 'pending',
        quote: '消失的引文ZZZ',
        note: '待处理备注',
        tags: [],
        position: null,
        context: { before: '', after: '' },
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
        lastRelocation: null,
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

function errorsOf(result: ReturnType<typeof buildImportDocument>): ImportAnnotationError[] {
  assert.ok(!result.ok, '应当导入失败')
  if (result.ok) throw new Error('unreachable')
  return result.errors
}

// ---------- 合法文件 ----------

check('合法导出文件：bound + pending 各一条，完整构建文档', () => {
  const result = buildImportDocument(makePayload(), 1234)
  assert.ok(result.ok, '应当导入成功')
  if (!result.ok) return
  const doc = result.document
  assert.strictEqual(doc.title, '导入校验文档')
  assert.strictEqual(doc.text, TEXT)
  assert.strictEqual(doc.updatedAt, 1234)
  assert.strictEqual(doc.annotations.length, 2)
  const [b, p] = doc.annotations
  assert.deepStrictEqual(
    { id: b.id, status: b.status, start: b.start, end: b.end, quote: b.quote, tags: b.tags },
    { id: 'a_one', status: 'bound', start: 0, end: 2, quote: '零一', tags: ['甲'] },
  )
  assert.strictEqual(b.contextAfter, TEXT.slice(2))
  assert.strictEqual(p.status, 'pending')
  assert.strictEqual(p.start, 0)
  assert.strictEqual(p.end, 0)
  assert.strictEqual(p.pendingReason, '原文中已找不到该引文，需要手动重新选择')
})

check('旧版缺省可选分区（缺全部新字段）仍可导入', () => {
  const payload = makePayload()
  for (const key of [
    'conflictRules',
    'ignoredConflicts',
    'coverageTags',
    'baseline',
    'reviewedDiffs',
    'sampleConfig',
    'sampleReviews',
    'relations',
    'relationCardinalityRules',
  ]) {
    delete (payload as Record<string, unknown>)[key]
  }
  const result = buildImportDocument(payload)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepStrictEqual(result.document.conflictRules, [])
  assert.deepStrictEqual(result.document.ignoredConflicts, [])
  assert.deepStrictEqual(result.document.coverageTags, [])
  assert.strictEqual(result.document.baseline, null)
  assert.deepStrictEqual(result.document.reviewedDiffs, [])
  assert.strictEqual(result.document.sampleConfig, null)
  assert.deepStrictEqual(result.document.sampleReviews, [])
  assert.deepStrictEqual(result.document.relations, [])
  assert.deepStrictEqual(result.document.relationCardinalityRules, [])
})

check('标注缺省 note/tags/context/pendingReason 时无损补空', () => {
  const payload = makePayload({
    annotations: [
      {
        id: 'a_one',
        status: 'bound',
        quote: TEXT.slice(0, 2),
        position: { start: 0, end: 2 },
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    ],
  })
  const result = buildImportDocument(payload)
  assert.ok(result.ok)
  if (!result.ok) return
  const a = result.document.annotations[0]
  assert.strictEqual(a.note, '')
  assert.deepStrictEqual(a.tags, [])
  assert.strictEqual(a.contextBefore, '')
  assert.strictEqual(a.contextAfter, '')
})

check('空标注数组的合法文件可导入', () => {
  const result = buildImportDocument(makePayload({ annotations: [] }))
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepStrictEqual(result.document.annotations, [])
})

check('边界区间：start=0、end=text.length 的满文区间合法', () => {
  const payload = makePayload({
    annotations: [
      {
        id: 'a_full',
        status: 'bound',
        quote: TEXT,
        note: '',
        tags: [],
        position: { start: 0, end: TEXT.length },
        context: { before: '', after: '' },
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    ],
  })
  const result = buildImportDocument(payload)
  assert.ok(result.ok, '满文区间应合法')
})

// ---------- 顶层结构错误 ----------

check('顶层结构错误：非对象 / 错 format / 缺 text / annotations 非数组', () => {
  for (const bad of [null, 42, 'str', []]) {
    const r = buildImportDocument(bad)
    assert.ok(!r.ok && r.formatError, `应报格式错误：${JSON.stringify(bad)}`)
  }
  let r = buildImportDocument({ format: 'other', document: { text: '' }, annotations: [] })
  assert.ok(!r.ok && r.formatError && r.formatError.includes('格式'))
  r = buildImportDocument({ format: 'anchor-annotation-console', document: {}, annotations: [] })
  assert.ok(!r.ok && r.formatError && r.formatError.includes('text'))
  r = buildImportDocument({
    format: 'anchor-annotation-console',
    document: { text: '' },
    annotations: {},
  })
  assert.ok(!r.ok && r.formatError && r.formatError.includes('annotations'))
})

// ---------- ID 校验 ----------

check('ID 为空串 / 缺失 / 非字符串：指出序号并拒绝', () => {
  const base = makePayload().annotations[0]
  const withIds = (ids: unknown[]) =>
    makePayload({ annotations: ids.map((id, i) => ({ ...base, id, quote: TEXT.slice(i, i + 1), position: { start: i, end: i + 1 } })) })

  let errs = errorsOf(buildImportDocument(withIds(['', 'a_two'])))
  assert.deepStrictEqual(errs.map((e) => e.index), [1])
  assert.ok(errs[0]!.reason.includes('ID'))

  errs = errorsOf(buildImportDocument(withIds([undefined, 'a_two'])))
  assert.deepStrictEqual(errs.map((e) => e.index), [1])

  errs = errorsOf(buildImportDocument(withIds([123, 'a_two'])))
  assert.deepStrictEqual(errs.map((e) => e.index), [1])
})

check('ID 全局唯一：重复 ID 从第二次出现起逐条报告并指出重复值', () => {
  const base = makePayload().annotations[0]
  const ann = (id: string, start: number) => ({
    ...base,
    id,
    quote: TEXT.slice(start, start + 1),
    position: { start, end: start + 1 },
  })
  const payload = makePayload({
    annotations: [ann('dup', 0), ann('dup', 1), ann('other', 2), ann('dup', 3)],
  })
  const errs = errorsOf(buildImportDocument(payload))
  assert.deepStrictEqual(errs.map((e) => e.index), [2, 4])
  assert.ok(errs.every((e) => e.reason.includes('dup') && e.reason.includes('重复')))
})

// ---------- 区间校验 ----------

check('已绑定标注缺 position：拒绝', () => {
  const payload = makePayload({
    annotations: [
      {
        id: 'a_nopos',
        status: 'bound',
        quote: '零一',
        note: '',
        tags: [],
        position: null,
        context: { before: '', after: '' },
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
  })
  const errs = errorsOf(buildImportDocument(payload))
  assert.deepStrictEqual(errs.map((e) => e.index), [1])
  assert.ok(errs[0]!.reason.includes('position'))
})

check('区间非整数（小数 / 字符串 / NaN）：拒绝', () => {
  const base = makePayload().annotations[0]
  const mk = (start: unknown, end: unknown) =>
    makePayload({ annotations: [{ ...base, id: 'a_x', position: { start, end } }] })
  for (const [s, e] of [[1.5, 2], [1, 2.5], ['0', '2'], [NaN, 2], [null, 2]] as [unknown, unknown][]) {
    const errs = errorsOf(buildImportDocument(mk(s, e)))
    assert.deepStrictEqual(errs.map((x) => x.index), [1], `start=${String(s)} end=${String(e)}`)
    assert.ok(errs[0]!.reason.includes('整数'), errs[0]!.reason)
  }
})

check('区间越界（负起点 / 终点超过原文长度）：拒绝', () => {
  const base = makePayload().annotations[0]
  let errs = errorsOf(
    buildImportDocument(makePayload({ annotations: [{ ...base, id: 'a_x', position: { start: -1, end: 2 } }] })),
  )
  assert.ok(errs[0]!.reason.includes('超出原文范围'))
  errs = errorsOf(
    buildImportDocument(makePayload({ annotations: [{ ...base, id: 'a_x', quote: TEXT.slice(8), position: { start: 8, end: 11 } }] })),
  )
  assert.ok(errs[0]!.reason.includes('超出原文范围'))
})

check('空区间或方向颠倒（start >= end）：拒绝', () => {
  const base = makePayload().annotations[0]
  for (const [s, e] of [[2, 2], [3, 1]]) {
    const errs = errorsOf(
      buildImportDocument(makePayload({ annotations: [{ ...base, id: 'a_x', quote: '', position: { start: s, end: e } }] })),
    )
    assert.ok(errs[0]!.reason.includes('start < end'), `区间 [${s}, ${e})`)
  }
})

check('区间文字与引文不符：拒绝并展示区间原文与引文', () => {
  const base = makePayload().annotations[0]
  const payload = makePayload({
    annotations: [
      { ...base, id: 'a_mismatch', quote: '三四', position: { start: 0, end: 2 } },
    ],
  })
  const errs = errorsOf(buildImportDocument(payload))
  assert.deepStrictEqual(errs.map((e) => e.index), [1])
  assert.ok(errs[0]!.reason.includes('不符'))
  assert.ok(errs[0]!.reason.includes('零一'), '应展示区间实际原文')
  assert.ok(errs[0]!.reason.includes('三四'), '应展示导入引文')
})

check('pending 标注不校验区间（position 为 null / 越界 / 空均可），引文也无需命中原文字', () => {
  const base = makePayload().annotations[1]
  for (const position of [null, { start: 5, end: 3 }, { start: 0, end: 0 }, { start: 100, end: 200 }]) {
    const result = buildImportDocument(
      makePayload({ annotations: [{ ...base, id: 'a_p', position }] }),
    )
    assert.ok(result.ok, `pending 位置 ${JSON.stringify(position)} 应放行`)
    if (result.ok) {
      assert.strictEqual(result.document.annotations[0].start, 0)
      assert.strictEqual(result.document.annotations[0].end, 0)
    }
  }
})

// ---------- 引文与对象形态 ----------

check('quote 非字符串：拒绝', () => {
  const base = makePayload().annotations[0]
  const payload = makePayload({
    annotations: [{ ...base, id: 'a_q', quote: 123, position: { start: 0, end: 2 } }],
  })
  const errs = errorsOf(buildImportDocument(payload))
  assert.ok(errs.some((e) => e.index === 1 && e.reason.includes('quote')))
})

check('数组元素不是对象：拒绝并指出序号', () => {
  const payload = makePayload({ annotations: [42, null, 'x'] })
  const errs = errorsOf(buildImportDocument(payload))
  assert.deepStrictEqual(errs.map((e) => e.index), [1, 2, 3])
  assert.ok(errs.every((e) => e.reason.includes('标注对象')))
})

check('多条记录不合格时一次性给出全部序号与原因', () => {
  const base = makePayload().annotations[0]
  const payload = makePayload({
    annotations: [
      { ...base, id: 'dup', quote: TEXT.slice(0, 1), position: { start: 0, end: 1 } },
      { ...base, id: 'dup', quote: TEXT.slice(1, 2), position: { start: 1, end: 2 } },
      { ...base, id: 'a_bad', quote: '错', position: { start: 2, end: 3 } },
    ],
  })
  const errs = errorsOf(buildImportDocument(payload))
  assert.deepStrictEqual(errs.map((e) => e.index), [2, 3])
})

// ---------- 关联记录只引用存在的标注 ----------

check('导入后关联记录经既有清洗：忽略 / 关系 / 结论引用缺失标注被剔除或派生失效', () => {
  const payload = makePayload({
    annotations: [
      {
        id: 'a_one',
        status: 'bound',
        quote: TEXT.slice(0, 2),
        note: '',
        tags: ['甲'],
        position: { start: 0, end: 2 },
        context: { before: '', after: '' },
        createdAt: 'x',
        updatedAt: 'x',
      },
    ],
    conflictRules: [{ id: 'r1', tagA: '甲', tagB: '乙', createdAt: '2026-09-20T00:00:00.000Z' }],
    // 一条引用存在标注 + 有效规则（保留），一条引用不存在标注（剔除）
    ignoredConflicts: [
      { annotationIds: ['a_one', 'a_gone'], ruleIds: ['r1'], createdAt: 'x' },
    ],
    // 一端引用不存在标注：关系保留为失效记录（与既有语义一致）
    relations: [
      { id: 'rel_1', sourceId: 'a_one', targetId: 'a_gone', type: '支撑', createdAt: 'x' },
      { id: 'rel_bad', sourceId: '', targetId: 'a_one', type: '支撑', createdAt: 'x' },
    ],
  })
  const result = buildImportDocument(payload)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepStrictEqual(result.document.ignoredConflicts, [])
  assert.strictEqual(result.document.relations.length, 1)
  assert.strictEqual(result.document.relations[0].id, 'rel_1')
  assert.strictEqual(result.document.conflictRules[0].id, 'r1')
})

console.log(`\n导入校验：${passed} 项断言全部通过`)
