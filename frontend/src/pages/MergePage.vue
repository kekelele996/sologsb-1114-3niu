<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MergeItem, Sketch } from '@/types'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { downloadCsv, formatTimestamp } from '@/utils/export'
import { stakeToNumber } from '@/utils/survey'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12
const PX_PER_METER = 1.6

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const draggingId = ref<string | null>(null)
const dragStartX = ref(0)
const dragOriginOffset = ref(0)
const snapLog = ref<string[]>([])

const offsets = reactive<Record<string, number>>({})
const snapped = reactive<Record<string, boolean>>({})

const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

const mergeSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter((sketch) => caveSegments.value.some((segment) => segment.id === sketch.segmentId))
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

function segmentOf(sketch: Sketch): string {
  const segment = segmentState.segments.find((item) => item.id === sketch.segmentId)
  return segment ? segment.code : '未归属'
}

function widthOf(sketch: Sketch): number {
  return Math.max(88, Math.round(sketch.gridCount * (200 / Math.max(10, sketch.scale)) * 4))
}

const totalWidth = computed(() =>
  mergeSketches.value.reduce((sum, sketch) => sum + widthOf(sketch) + 10, 0)
)

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

// 拼合布局随图幅持久化：切换洞穴或重开页面后按原编排恢复；
// 拖拽进行中以本地值为准，避免被水合结果覆盖
watch(
  mergeSketches,
  (list) => {
    list.forEach((sketch) => {
      if (draggingId.value === sketch.id) return
      offsets[sketch.id] = sketch.mergeOffset ?? 0
      snapped[sketch.id] = sketch.mergeSnapped ?? false
    })
  },
  { immediate: true }
)

/** 洞段测点闭合差（拼合视图复用闭合差徽标） */
const caveStations = computed(() =>
  stationState.stations.filter((station) =>
    caveSegments.value.some((segment) => segment.id === station.segmentId)
  )
)
const { result: closureResult } = useClosureCheck(caveStations)

/** 按桩号锚点自动吸附：以最小锚点桩号为原点，按桩号差换算横向偏移 */
async function autoAlign(): Promise<void> {
  const list = mergeSketches.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合草图')
    return
  }
  const base = Math.min(...list.map((sketch) => stakeToNumber(sketch.anchorStake)))
  const logs: string[] = []
  const layout: MergeItem[] = []
  list.forEach((sketch) => {
    const stake = stakeToNumber(sketch.anchorStake)
    const target = Math.round((stake - base) * PX_PER_METER)
    offsets[sketch.id] = target
    snapped[sketch.id] = true
    layout.push({ sketchId: sketch.id, offset: target, snapped: true })
    logs.push(`${sketch.code} 锚点 ${sketch.anchorStake} → 偏移 ${target}px`)
  })
  snapLog.value = logs
  await sketchStore.getState().saveLayout(layout)
  ElMessage.success(`已按桩号锚点吸附 ${list.length} 张图幅`)
}

function onMouseDown(sketch: Sketch, event: MouseEvent): void {
  draggingId.value = sketch.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sketch.id] ?? 0
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = mergeSketches.value
  const index = list.findIndex((sketch) => sketch.id === draggingId.value)
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = list.filter((sketch) => sketch.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.id] ?? 0) + widthOf(other)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.code
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    const current = list[index]
    snapLog.value = [`${current.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
  }
}

async function onMouseUp(): Promise<void> {
  const id = draggingId.value
  draggingId.value = null
  if (!id) return
  // 拖拽结束后把该图幅的偏移与吸附状态写入本洞拼合目录
  await sketchStore.getState().saveLayout([{ sketchId: id, offset: offsets[id] ?? 0, snapped: snapped[id] ?? false }])
}

/** 拼合顺序表（输出结果） */
interface MergeRow {
  order: number
  code: string
  segment: string
  anchorStake: string
  offset: number
  snapped: boolean
}

const mergeRows = computed<MergeRow[]>(() =>
  mergeSketches.value.map((sketch, index) => ({
    order: index + 1,
    code: sketch.code,
    segment: segmentOf(sketch),
    anchorStake: sketch.anchorStake,
    offset: offsets[sketch.id] ?? 0,
    snapped: snapped[sketch.id] ?? false
  }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = [...mergeSketches.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  const temp = list[index]
  list[index] = list[target]
  list[target] = temp
  // 只重排本洞图幅，连续编号由 store 保证不波及其他洞穴
  await sketchStore.getState().reorder(list.map((sketch) => sketch.id))
}

/** 导出前检查：草图编号与桩号锚点重复或缺失时，逐条指出具体图幅 */
function collectExportProblems(): string[] {
  const problems: string[] = []
  const list = mergeSketches.value
  const codeGroups = new Map<string, Sketch[]>()
  const anchorGroups = new Map<string, Sketch[]>()
  list.forEach((sketch) => {
    const code = sketch.code.trim()
    const anchor = sketch.anchorStake.trim()
    if (!code) {
      problems.push(`图幅缺少草图编号（洞段 ${segmentOf(sketch)}，锚点 ${anchor || '未填'}）`)
    } else {
      codeGroups.set(code, [...(codeGroups.get(code) ?? []), sketch])
    }
    if (!anchor) {
      problems.push(`图幅「${code || '未编号'}」缺少桩号锚点（洞段 ${segmentOf(sketch)}）`)
    } else {
      anchorGroups.set(anchor, [...(anchorGroups.get(anchor) ?? []), sketch])
    }
  })
  codeGroups.forEach((group, code) => {
    if (group.length > 1) {
      problems.push(
        `草图编号「${code}」重复 ${group.length} 次（洞段 ${group.map((sketch) => segmentOf(sketch)).join('、')}）`
      )
    }
  })
  anchorGroups.forEach((group, anchor) => {
    if (group.length > 1) {
      problems.push(
        `桩号锚点「${anchor}」被 ${group.length} 张图幅重复使用（${group.map((sketch) => sketch.code.trim() || '未编号').join('、')}）`
      )
    }
  })
  return problems
}

async function exportMergeTable(): Promise<void> {
  if (mergeSketches.value.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合草图')
    return
  }
  const problems = collectExportProblems()
  if (problems.length > 0) {
    await ElMessageBox.alert(
      h('div', problems.map((item) => h('div', { style: 'line-height:1.9' }, `• ${item}`))),
      '导出前检查未通过，请修正后重试',
      { type: 'error', confirmButtonText: '知道了' }
    )
    return
  }
  const exportedAt = formatTimestamp(new Date())
  const caveName = caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.name ?? '全部洞穴'
  const rows = mergeRows.value.map((row) => ({
    order: row.order,
    code: row.code,
    segment: row.segment,
    anchorStake: row.anchorStake,
    offset: row.offset,
    snapped: row.snapped ? '已吸附' : '未吸附',
    exportedAt
  }))
  downloadCsv(
    `图幅拼合顺序表_${caveName}_${exportedAt.replace(/[-:]/g, '').replace(' ', '_')}.csv`,
    rows,
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'code', label: '草图编号' },
      { key: 'segment', label: '洞段' },
      { key: 'anchorStake', label: '锚点桩号' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' },
      { key: 'exportedAt', label: '导出时间' }
    ]
  )
  ElMessage.success('拼合顺序表已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合视图</h2>
        <p class="page-sub">
          拼合目录按洞穴保存：新图接在本洞末尾，上移/下移只调整本洞编号，偏移与吸附状态随图幅持久化；导出前自动检查草图编号与锚点。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="autoAlign">按桩号锚点吸附对齐</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">图幅 {{ mergeSketches.length }} 张</el-tag>
      <el-tag effect="plain">总宽 {{ totalWidth }} px</el-tag>
      <div class="seg-tags">
        <SegmentTag
          v-for="segment in caveSegments"
          :key="segment.id"
          :type="segment.type"
          :code="segment.code"
          :closed="segment.closed"
          size="small"
        />
      </div>
    </div>

    <div class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
      <GridCanvas
        :width="CANVAS_W"
        :height="CANVAS_H"
        :grid-size="20"
        :meters-per-grid="1"
        title="图幅拼合台（拖动对齐 / 锚点吸附）"
      >
        <g
          v-for="(sketch, index) in mergeSketches"
          :key="sketch.id"
          class="sheet-group"
          @mousedown.prevent="onMouseDown(sketch, $event)"
        >
          <rect
            :x="offsets[sketch.id] ?? 0"
            :y="40 + (index % 2) * 10"
            :width="widthOf(sketch)"
            height="96"
            rx="6"
            :fill="snapped[sketch.id] ? 'rgba(47,111,143,0.22)' : 'rgba(143,211,199,0.28)'"
            :stroke="snapped[sketch.id] ? '#2f6f8f' : '#1f8a70'"
            stroke-width="1.6"
          />
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
            {{ sketch.code }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
            锚点 {{ sketch.anchorStake }}
          </text>
          <text :x="(offsets[sketch.id] ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
            1:{{ sketch.scale }} · {{ sketch.gridCount }} 格
          </text>
          <line
            :x1="offsets[sketch.id] ?? 0"
            :y1="136 + (index % 2) * 10"
            :x2="(offsets[sketch.id] ?? 0) + 14"
            :y2="136 + (index % 2) * 10"
            stroke="#c98a1b"
            stroke-width="2"
          />
        </g>
        <text
          v-if="mergeSketches.length === 0"
          :x="CANVAS_W / 2 - 110"
          :y="CANVAS_H / 2"
          font-size="13"
          fill="#8a97a3"
        >
          该洞穴暂无草图图幅，请先到「草图工作台」建立
        </text>
        <template #legend>
          <span>拖动图幅可移动</span>
          <span>绿框 = 未吸附</span>
          <span>蓝框 = 已吸附对齐</span>
          <span>橙色短划 = 锚点桩号位置</span>
        </template>
      </GridCanvas>
      </div>

      <div class="side">
        <ClosureBadge
          :closure="closureResult.closure"
          :threshold="closureResult.threshold"
          :level="closureResult.level"
          :detail="closureResult.detail"
          :count="caveStations.length"
        />
        <el-card shadow="never" class="log-card">
          <template #header>吸附记录</template>
          <ul class="log">
            <li v-for="(line, index) in snapLog" :key="index">{{ line }}</li>
            <li v-if="snapLog.length === 0" class="muted">拖动图幅或点击「按桩号锚点吸附对齐」后显示结果</li>
          </ul>
        </el-card>
      </div>
    </div>

    <h3 class="section-title">图幅拼合顺序表</h3>
    <el-table :data="mergeRows" border stripe>
      <el-table-column prop="order" label="拼合顺序" width="100" />
      <el-table-column prop="code" label="草图编号" width="120" />
      <el-table-column prop="segment" label="洞段" width="120" />
      <el-table-column prop="anchorStake" label="桩号对齐锚点" width="150" />
      <el-table-column label="对齐偏移" width="120">
        <template #default="{ row }: { row: MergeRow }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附状态" width="120">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="调整顺序" width="180">
        <template #default="{ $index }: { $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === mergeRows.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.seg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
}
.log-card {
  border-radius: 12px;
}
.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5b6b;
  line-height: 1.8;
}
.sheet-group {
  cursor: grab;
}
</style>
