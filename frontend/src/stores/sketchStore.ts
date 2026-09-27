import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

/** 取洞段所属洞穴 */
async function caveIdOfSegment(segmentId: string): Promise<string> {
  const segment = await db.segments.get(segmentId)
  return segment?.caveId ?? ''
}

/** 取某洞穴下的全部草图（按拼合顺序） */
async function listCaveSketches(caveId: string): Promise<Sketch[]> {
  const segmentIds = new Set(await db.segments.where('caveId').equals(caveId).primaryKeys())
  const sketches = await syncAll<Sketch>(db.sketches)
  return sketches
    .filter((sketch) => segmentIds.has(sketch.segmentId))
    .sort((a, b) => a.mergeOrder - b.mergeOrder || a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

/** 把某洞穴内图幅重新整理为从 1 起的连续编号（其它洞穴不动） */
async function renumberCave(caveId: string): Promise<void> {
  if (!caveId) return
  const list = await listCaveSketches(caveId)
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
  /** 新建草图自动接在本洞末尾；编辑后仍保证本洞编号连续 */
  save: (sketch: Sketch) => Promise<void>
  /** 删除后本洞其余图幅顺位补位 */
  remove: (id: string) => Promise<void>
  /** 按传入顺序（仅本洞图幅）连续编号，不影响其它洞穴 */
  reorder: (orderedCaveSketchIds: string[]) => Promise<void>
  /** 持久化单张图幅的偏移与吸附状态 */
  setLayout: (id: string, offset: number, snapped: boolean) => Promise<void>
  /** 批量持久化偏移与吸附状态（锚点一键吸附） */
  setLayouts: (updates: { id: string; offset: number; snapped: boolean }[]) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder || a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    const caveId = await caveIdOfSegment(sketch.segmentId)
    const existing = get().sketches.find((item) => item.id === sketch.id)
    const prevCaveId = existing ? await caveIdOfSegment(existing.segmentId) : ''

    const normalized: Sketch = {
      ...sketch,
      offset: Number.isFinite(sketch.offset) ? sketch.offset : existing?.offset ?? 0,
      snapped: typeof sketch.snapped === 'boolean' ? sketch.snapped : existing?.snapped ?? false
    }
    if (!existing) {
      // 新图接在本洞末尾
      normalized.mergeOrder = (await listCaveSketches(caveId)).length + 1
    } else if (existing.mergeOrder > 0) {
      normalized.mergeOrder = existing.mergeOrder
    }

    await syncPut<Sketch>(db.sketches, normalized)
    await renumberCave(caveId)
    // 编辑时若改挂到另一洞穴，原洞穴也要补位
    if (prevCaveId && prevCaveId !== caveId) await renumberCave(prevCaveId)
    await get().hydrate()
  },
  remove: async (id) => {
    const existing = get().sketches.find((item) => item.id === id)
    const caveId = existing ? await caveIdOfSegment(existing.segmentId) : ''
    await syncDelete(db.sketches, id)
    await renumberCave(caveId)
    await get().hydrate()
  },
  reorder: async (orderedCaveSketchIds) => {
    const byId = new Map(get().sketches.map((item) => [item.id, item]))
    await Promise.all(
      orderedCaveSketchIds.map((id, index) => {
        const target = byId.get(id)
        if (!target || target.mergeOrder === index + 1) return Promise.resolve()
        return syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 })
      })
    )
    await get().hydrate()
  },
  setLayout: async (id, offset, snapped) => {
    const target = get().sketches.find((item) => item.id === id)
    if (!target) return
    await syncPut<Sketch>(db.sketches, { ...target, offset, snapped })
    await get().hydrate()
  },
  setLayouts: async (updates) => {
    const byId = new Map(get().sketches.map((item) => [item.id, item]))
    await Promise.all(
      updates.map(({ id, offset, snapped }) => {
        const target = byId.get(id)
        return target ? syncPut<Sketch>(db.sketches, { ...target, offset, snapped }) : Promise.resolve()
      })
    )
    await get().hydrate()
  }
}))
