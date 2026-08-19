export const Tool = {
  select: 'select',
  pan: 'pan',
  circle: 'circle',
  rect: 'rect',
  polygon: 'polygon',
  line: 'line',
  force: 'force',
  measure: 'measure',
  fluid: 'fluid',
  joint: 'joint',
} as const
export type Tool = (typeof Tool)[keyof typeof Tool]

export const TOOL_META: {
  id: Tool
  label: string
  hint: string
  group: 'nav' | 'create' | 'phys'
}[] = [
  { id: 'select', label: 'Seleccionar', hint: 'V', group: 'nav' },
  { id: 'pan', label: 'Mano', hint: 'H', group: 'nav' },
  { id: 'circle', label: 'Círculo', hint: 'C', group: 'create' },
  { id: 'rect', label: 'Rectángulo', hint: 'R', group: 'create' },
  { id: 'polygon', label: 'Polígono', hint: 'G', group: 'create' },
  { id: 'line', label: 'Plataforma', hint: 'L', group: 'create' },
  { id: 'fluid', label: 'Fluido', hint: 'W · empuje 2D, superficie plana', group: 'create' },
  { id: 'force', label: 'Fuerza', hint: 'F · arrastra; Mayús sostiene', group: 'phys' },
  { id: 'measure', label: 'Medir', hint: 'M', group: 'phys' },
  { id: 'joint', label: 'Unir', hint: 'J · arrastra de un cuerpo a otro', group: 'phys' },
]
