<script lang="ts">
  import flamegraph, { type FlameGraphChart, type FlameHierarchyNode } from 'd3-flame-graph';
  import { select } from 'd3-selection';
  import type { ResolveFunc } from '../../shared/artifacts';
  import { buildFlameGraph, type FlameFrame } from '../../shared/flame';
  import type { ProfileRun } from '../../shared/profile';
  import QualityBadge from './QualityBadge.svelte';

  let {
    run,
    totalMs,
    resolve
  }: { run: ProfileRun; totalMs: number; resolve?: ResolveFunc } = $props();

  let host = $state<HTMLDivElement | undefined>(undefined);
  let selected = $state<FlameFrame | undefined>(undefined);
  let chart: FlameGraphChart | undefined;

  const data = $derived(buildFlameGraph(run, resolve));

  $effect(() => {
    const container = host;
    const tree = data;
    if (!container) return;

    let lastWidth = -1;
    const render = (): void => {
      const width = container.clientWidth;
      if (width === 0 || width === lastWidth) return;
      lastWidth = width;
      chart?.destroy();
      container.replaceChildren();
      chart = flamegraph()
        .width(width)
        .cellHeight(20)
        .minFrameSize(1)
        .transitionDuration(150)
        .tooltip(false)
        .onClick((node: FlameHierarchyNode) => {
          selected = node.data as FlameFrame;
        });
      select(container).datum(tree).call(chart);
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart?.destroy();
      chart = undefined;
    };
  });

  function resetZoom(): void {
    chart?.resetZoom();
    selected = undefined;
  }

  const pct = (ms: number): string => (totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : '0.0');
</script>

<div class="space-y-3">
  <div class="flex items-center gap-3 text-sm text-neutral-400">
    <button class="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700" onclick={resetZoom}>
      Reset zoom
    </button>
    <span>Width is total time; click a frame to zoom and inspect it.</span>
  </div>

  <div bind:this={host} class="flame-host w-full"></div>

  {#if selected}
    <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm space-y-1">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="font-mono text-neutral-100">{selected.name}</span>
        {#if selected.quality}<QualityBadge quality={selected.quality} />{/if}
        {#if selected.funcIndex !== undefined}
          <span class="font-mono text-neutral-500">function index #{selected.funcIndex}</span>
          {#if selected.inferredFuncIdx}
            <span
              class="rounded bg-amber-950 px-1.5 py-0.5 text-xs text-amber-300"
              title="function index inferred by name match, not reported by the runtime"
            >inferred</span>
          {:else}
            <span
              class="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400"
              title="function index reported by the runtime"
            >reported</span>
          {/if}
        {:else}
          <span class="text-neutral-500">function index unavailable</span>
        {/if}
      </div>
      <div class="font-mono text-neutral-400">
        total {selected.value.toFixed(1)}ms ({pct(selected.value)}%) · self
        {selected.selfMs.toFixed(1)}ms ({pct(selected.selfMs)}%)
        {#if selected.samples !== undefined}· {selected.samples} samples{/if}
        {#if selected.calls !== undefined}· {selected.calls} calls{/if}
      </div>
      {#if selected.source}
        <div class="flex items-center gap-1.5 text-neutral-500">
          <span class="truncate" title={selected.source}>{selected.source}</span>
          {#if selected.inferredSource}
            <span
              class="shrink-0 rounded bg-amber-950 px-1 text-xs text-amber-300"
              title="source location from a name match; no artifact was verified against the running module"
            >unverified</span>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <p class="text-sm text-neutral-500">No frame selected.</p>
  {/if}
</div>

<style>
  .flame-host :global(.d3-flame-graph rect) {
    stroke: #171717;
    stroke-width: 0.5;
    fill-opacity: 0.9;
  }
  .flame-host :global(.d3-flame-graph rect:hover) {
    stroke: #fafafa;
    stroke-width: 1;
    cursor: pointer;
  }
  .flame-host :global(.d3-flame-graph .fade) {
    opacity: 0.4;
  }
  .flame-host :global(.d3-flame-graph-label) {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    margin: 0 4px;
    line-height: 1.6;
    text-align: left;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #0a0a0a;
  }
</style>
