import { createStore } from 'zustand/vanilla'
import type { MergeItem, Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

/** 查询洞段所属洞穴 */
async function caveIdOfSegment(segmentId: string): Promise<string | null> {
  const segment = await db.segments.get(segmentId)
  return segment?.caveId ?? null
}

/** 某洞穴名下全部草图（经洞段归属反查） */
async function sketchesOfCave(caveId: string): Promise<Sketch[]> {
  const segments = await db.segments.where('caveId').equals(caveId).toArray()
  const segmentIds = new Set(segments.map((segment) => segment.id))
  const sketches = await db.sketches.toArray()
  return sketches.filter((sketch) => segmentIds.has(sketch.segmentId))
}

/** 本洞下一张图幅的顺序号：接在本洞末尾 */
async function nextMergeOrder(caveId: string): Promise<number> {
  const list = await sketchesOfCave(caveId)
  return (
    list.reduce((max, sketch) => Math.max(max, Number.isFinite(sketch.mergeOrder) ? sketch.mergeOrder : 0), 0) + 1
  )
}

/** 本洞草图按当前顺序重新连续编号（移除补位 / 跨洞移动后调用），不影响其他洞穴 */
async function renumberCave(caveId: string): Promise<void> {
  const list = (await sketchesOfCave(caveId)).sort(
    (a, b) =>
      (Number.isFinite(a.mergeOrder) ? a.mergeOrder : 0) - (Number.isFinite(b.mergeOrder) ? b.mergeOrder : 0)
  )
  await Promise.all(
    list.map((sketch, index) =>
      sketch.mergeOrder === index + 1
        ? Promise.resolve()
        : syncPut<Sketch>(db.sketches, { ...sketch, mergeOrder: index + 1 })
    )
  )
}

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  saveLayout: (items: MergeItem[]) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    const existing = await db.sketches.get(sketch.id)
    const caveId = await caveIdOfSegment(sketch.segmentId)
    const oldCaveId = existing ? await caveIdOfSegment(existing.segmentId) : null
    let mergeOrder = sketch.mergeOrder
    if (!existing) {
      // 新图接在本洞末尾
      if (caveId) mergeOrder = await nextMergeOrder(caveId)
    } else if (caveId && oldCaveId && caveId !== oldCaveId) {
      // 改挂到其他洞穴：接在新洞末尾，旧洞随后补位重排
      mergeOrder = await nextMergeOrder(caveId)
    } else {
      // 本洞内编辑：顺序号不变
      mergeOrder = existing.mergeOrder
    }
    await syncPut<Sketch>(db.sketches, { ...sketch, mergeOrder })
    if (oldCaveId && oldCaveId !== caveId) await renumberCave(oldCaveId)
    await get().hydrate()
  },
  remove: async (id) => {
    const existing = await db.sketches.get(id)
    await syncDelete(db.sketches, id)
    // 移除后本洞补位，保持连续编号
    if (existing) {
      const caveId = await caveIdOfSegment(existing.segmentId)
      if (caveId) await renumberCave(caveId)
    }
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    // 只重排传入的本洞图幅清单（1..n 连续编号），其他洞穴的编号不受影响
    const all = await db.sketches.toArray()
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target && target.mergeOrder !== index + 1
          ? syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 })
          : Promise.resolve()
      })
    )
    await get().hydrate()
  },
  saveLayout: async (items) => {
    // 每张图幅的偏移与吸附状态随记录持久化，切换洞穴或重开后按原编排恢复
    if (items.length === 0) return
    const all = await db.sketches.toArray()
    await Promise.all(
      items.map((item) => {
        const target = all.find((sketch) => sketch.id === item.sketchId)
        if (!target) return Promise.resolve()
        if (target.mergeOffset === item.offset && target.mergeSnapped === item.snapped) {
          return Promise.resolve()
        }
        return syncPut<Sketch>(db.sketches, { ...target, mergeOffset: item.offset, mergeSnapped: item.snapped })
      })
    )
    await get().hydrate()
  }
}))
