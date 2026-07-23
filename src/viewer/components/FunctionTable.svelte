<script lang="ts">
  import type { ResolveFunc } from '../../shared/artifacts';
  import { aggregateFunctions, type FunctionRow } from '../../shared/callTree';
  import type { ProfileRun, SymbolQuality } from '../../shared/profile';
  import QualityBadge from './QualityBadge.svelte';

  let {
    run,
    totalMs,
    resolve
  }: { run: ProfileRun; totalMs: number; resolve?: ResolveFunc } = $props();

  interface RowView {
    row: FunctionRow;
    name: string;
    quality: SymbolQuality;
    funcIndex?: number;
    inferred: boolean;
    inferredSource: boolean;
    file?: string;
    line?: number;
    source?: string;
  }

  let selectedLabel = $state<string | undefined>(undefined);

  const views = $derived.by<RowView[]>(() =>
    aggregateFunctions(run).map((row) => {
      const r = resolve?.({
        label: row.label,
        funcIndex: row.funcIndex,
        quality: row.quality,
        source: undefined,
        moduleId: row.moduleId
      });
      const file = r?.source;
      return {
        row,
        name: r?.name ?? row.label,
        quality: r?.quality ?? row.quality,
        funcIndex: r?.funcIndex ?? row.funcIndex,
        inferred: r?.inferredFuncIdx === true,
        inferredSource: r?.inferredSource === true,
        file,
        line: r?.line,
        source: file !== undefined ? file + (r?.line !== undefined ? `:${r.line}` : '') : undefined
      };
    })
  );

  const selected = $derived(views.find((v) => v.row.label === selectedLabel));

  const moduleLabel = (id: string | undefined): string => {
    if (id === undefined) return 'unknown';
    const module = run.modules[id];
    if (!module) return id;
    return module.url ?? (module.hash !== '' ? `${id} (${module.hash.slice(0, 8)})` : id);
  };

  const pct = (ms: number): string => (totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : '0.0');
  const tracing = $derived(run.mode === 'tracing');
</script>

<div class="space-y-3">
  <p class="text-sm text-neutral-400">Click a row to inspect the function.</p>

  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-neutral-800 text-left text-neutral-400">
          <th class="py-1.5 pr-4 font-medium">Function</th>
          <th class="py-1.5 pr-4 text-right font-medium">Total</th>
          <th class="py-1.5 pr-4 text-right font-medium">Self</th>
          {#if tracing}
            <th class="py-1.5 pr-4 text-right font-medium">Calls</th>
          {:else}
            <th class="py-1.5 pr-4 text-right font-medium">Samples</th>
            <th class="py-1.5 pr-4 text-right font-medium">Self samples</th>
          {/if}
          <th class="py-1.5 pr-4 font-medium">Quality</th>
          <th class="py-1.5 font-medium">Source</th>
        </tr>
      </thead>
      <tbody>
        {#each views as view (view.row.label)}
          <tr
            class="cursor-pointer border-b border-neutral-900 hover:bg-neutral-900/60 {view.row
              .label === selectedLabel
              ? 'bg-neutral-800/60'
              : ''}"
            tabindex="0"
            aria-selected={view.row.label === selectedLabel}
            onclick={() => (selectedLabel = view.row.label)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectedLabel = view.row.label;
              }
            }}
          >
            <td class="py-1 pr-4 font-mono whitespace-nowrap" title={view.row.label}>{view.name}</td>
            <td class="py-1 pr-4 text-right font-mono whitespace-nowrap">
              {view.row.totalMs.toFixed(1)}ms
              <span class="text-neutral-500">{pct(view.row.totalMs)}%</span>
            </td>
            <td class="py-1 pr-4 text-right font-mono whitespace-nowrap">
              {view.row.selfMs.toFixed(1)}ms
              <span class="text-neutral-500">{pct(view.row.selfMs)}%</span>
            </td>
            {#if tracing}
              <td class="py-1 pr-4 text-right font-mono">{view.row.calls}</td>
            {:else}
              <td class="py-1 pr-4 text-right font-mono">{view.row.samples}</td>
              <td class="py-1 pr-4 text-right font-mono">{view.row.selfSamples}</td>
            {/if}
            <td class="py-1 pr-4"><QualityBadge quality={view.quality} /></td>
            <td class="max-w-64 truncate py-1 text-neutral-500" title={view.source}>{view.source ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if selected}
    <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm space-y-1">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="font-mono text-neutral-100">{selected.name}</span>
        <QualityBadge quality={selected.quality} />
        {#if selected.funcIndex !== undefined}
          <span class="font-mono text-neutral-500">function index #{selected.funcIndex}</span>
          {#if selected.inferred}
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
      {#if selected.name !== selected.row.label}
        <div class="truncate font-mono text-neutral-500" title={selected.row.label}>
          raw frame {selected.row.label}
        </div>
      {/if}
      <div class="font-mono text-neutral-400">
        total {selected.row.totalMs.toFixed(1)}ms ({pct(selected.row.totalMs)}%) · self
        {selected.row.selfMs.toFixed(1)}ms ({pct(selected.row.selfMs)}%)
        {#if tracing}
          · {selected.row.calls} calls
        {:else}
          · {selected.row.samples} samples · {selected.row.selfSamples} self samples
        {/if}
        · {selected.row.nodeCount} node{selected.row.nodeCount === 1 ? '' : 's'}
      </div>
      <div class="truncate text-neutral-500" title={moduleLabel(selected.row.moduleId)}>
        module {moduleLabel(selected.row.moduleId)}
      </div>
      {#if selected.file !== undefined}
        <div class="flex items-center gap-1.5 text-neutral-500">
          <span class="truncate" title={selected.source}>
            {selected.file}{#if selected.line !== undefined}<span class="text-neutral-400"
                >:{selected.line}</span
              >{/if}
          </span>
          {#if selected.inferredSource}
            <span
              class="shrink-0 rounded bg-amber-950 px-1 text-xs text-amber-300"
              title="source location from a name match; no artifact was verified against the running module"
            >unverified</span>
          {/if}
        </div>
      {:else}
        <div class="text-neutral-500">no source location</div>
      {/if}
    </div>
  {:else}
    <p class="text-sm text-neutral-500">No function selected.</p>
  {/if}
</div>
