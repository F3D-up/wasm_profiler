<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { ResolveFunc } from '../../shared/artifacts';
  import { flattenCallTree } from '../../shared/callTree';
  import type { ProfileRun } from '../../shared/profile';
  import QualityBadge from './QualityBadge.svelte';

  let {
    run,
    totalMs,
    resolve
  }: { run: ProfileRun; totalMs: number; resolve?: ResolveFunc } = $props();

  const INDENT_REM = 1.25;
  const INDENT_PX = INDENT_REM * 16;
  const RESERVED_PX = 640;

  const collapsed = new SvelteSet<number>();
  const expanded = new SvelteSet<number>();

  let viewWidth = $state(0);

  const depths = $derived.by(() => {
    const found = new Map<number, number>();
    const stack: Array<[number, number]> = run.roots.map((id) => [id, 0]);

    while (stack.length > 0) {
      const [id, depth] = stack.pop()!;
      const node = run.nodes[id];
      if (!node) continue;

      found.set(id, depth);
      for (const child of node.children) stack.push([child, depth + 1]);
    }

    return found;
  });

  const maxDepth = $derived(
    viewWidth > 0 ? Math.max(1, Math.floor((viewWidth - RESERVED_PX) / INDENT_PX)) : Infinity
  );

  const folded = $derived.by(() => {
    const set = new Set<number>();

    for (const [id, depth] of depths) {
      if (collapsed.has(id)) set.add(id);
      else if (!expanded.has(id) && depth >= maxDepth) set.add(id);
    }

    return set;
  });

  const rows = $derived(flattenCallTree(run, folded));

  function toggle(id: number): void {
    if (folded.has(id)) {
      collapsed.delete(id);
      expanded.add(id);
    } else {
      expanded.delete(id);
      collapsed.add(id);
    }
  }

  const pct = (ms: number): string => (totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : '0.0');
  const tracing = $derived(run.mode === 'tracing');
</script>

<div bind:clientWidth={viewWidth} class="overflow-x-auto">
  <table class="w-max min-w-full text-sm">
    <thead>
      <tr class="border-b border-neutral-800 text-left text-neutral-400">
        <th class="py-1.5 pr-4 font-medium">Function</th>
        <th class="py-1.5 pr-4 text-right font-medium">Total</th>
        <th class="py-1.5 pr-4 text-right font-medium">Self</th>
        <th class="py-1.5 pr-4 text-right font-medium">{tracing ? 'Calls' : 'Samples'}</th>
        <th class="py-1.5 pr-4 font-medium">Quality</th>
        <th class="py-1.5 font-medium">Source</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.node.id)}
        {@const r = resolve?.(row.node)}
        {@const source = r?.source !== undefined ? r.source + (r.line !== undefined ? `:${r.line}` : '') : row.node.source}
        <tr class="border-b border-neutral-900 hover:bg-neutral-900/60">
          <td class="py-1 pr-4 whitespace-nowrap">
            <span style="padding-left: {row.depth * INDENT_REM}rem"></span>
            {#if row.hasChildren}
              <button class="mr-1 inline-block w-4 text-neutral-500" onclick={() => toggle(row.node.id)}>
                {folded.has(row.node.id) ? '▸' : '▾'}
              </button>
            {:else}
              <span class="mr-1 inline-block w-4"></span>
            {/if}
            <span class="font-mono" title={row.node.label}>{r?.name ?? row.node.label}</span>
            {#if row.recursive}
              <span class="ml-1 rounded bg-indigo-950 px-1 text-xs text-indigo-300" title="same function appears in an ancestor frame">↻</span>
            {/if}
            {#if r?.inferredFuncIdx}
              <span class="ml-1 rounded bg-amber-950 px-1 text-xs text-amber-300" title="function index inferred by name match">~#{r.funcIndex}</span>
            {/if}
          </td>
          <td class="py-1 pr-4 text-right font-mono whitespace-nowrap">
            {row.node.totalMs.toFixed(1)}ms
            <span class="text-neutral-500">{pct(row.node.totalMs)}%</span>
          </td>
          <td class="py-1 pr-4 text-right font-mono whitespace-nowrap">
            {row.node.selfMs.toFixed(1)}ms
            <span class="text-neutral-500">{pct(row.node.selfMs)}%</span>
          </td>
          <td class="py-1 pr-4 text-right font-mono">
            {tracing ? (row.node.calls ?? 0) : (row.node.samples ?? 0)}
          </td>
          <td class="py-1 pr-4"><QualityBadge quality={r?.quality ?? row.node.quality} /></td>
          <td class="max-w-64 py-1 text-neutral-500" title={source}>
            <span class="inline-block max-w-full truncate align-middle">{source ?? ''}</span>
            {#if r?.inferredSource}
              <span
                class="ml-1 rounded bg-amber-950 px-1 align-middle text-xs text-amber-300"
                title="source location from a name match; no artifact was verified against the running module"
              >?</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
