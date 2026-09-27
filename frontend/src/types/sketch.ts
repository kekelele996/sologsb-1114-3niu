/** Sketch 草图 */
export interface Sketch {
  id: string
  segmentId: string
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号（按洞穴各自从 1 连续编号，由拼合目录自动维护） */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
  /** 拼合台横向偏移（px），随图幅持久化，切换洞穴或重开后按原编排恢复 */
  mergeOffset?: number
  /** 是否已吸附对齐，随图幅持久化 */
  mergeSnapped?: boolean
}

/** 图幅拼合对齐结果（单张图幅的持久化布局） */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：px） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}
