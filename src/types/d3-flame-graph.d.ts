declare module 'd3-flame-graph' {
  export interface FlameHierarchyNode {
    data: unknown;
    value: number;
    x0: number;
    x1: number;
  }

  export interface FlameGraphChart {
    (selection: unknown): void;
    width(px: number): this;
    height(px: number): this;
    cellHeight(px: number): this;
    minFrameSize(px: number): this;
    transitionDuration(ms: number): this;
    tooltip(enabled: boolean): this;
    inverted(inverted: boolean): this;
    sort(
      comparator: ((a: FlameHierarchyNode, b: FlameHierarchyNode) => number) | boolean
    ): this;
    onClick(handler: (node: FlameHierarchyNode) => void): this;
    resetZoom(): void;
    update(data?: unknown): this;
    destroy(): void;
  }

  export default function flamegraph(): FlameGraphChart;
}

declare module 'd3-selection' {
  export interface MinimalSelection {
    datum(data: unknown): MinimalSelection;
    call(fn: (selection: unknown) => void): MinimalSelection;
  }

  export function select(node: Element): MinimalSelection;
}
