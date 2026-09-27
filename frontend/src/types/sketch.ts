/** Sketch 草图（拼合编排按所属洞穴独立保存） */
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
  /** 图幅拼合顺序号（在本洞内从 1 起连续编号） */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
  /** 拼合台横向偏移（px，随编排一起持久化） */
  offset: number
  /** 是否已吸附（随编排一起持久化） */
  snapped: boolean
}
