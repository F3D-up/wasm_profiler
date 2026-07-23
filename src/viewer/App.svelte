<script lang="ts">
  import {
    clearArtifacts,
    loadArtifacts,
    parseArtifact,
    resolveFrame,
    saveArtifact,
    artifactMatchesModule,
    isRuntimeCompatible,
    type ResolveFunc
  } from '../shared/artifacts';
  import { totalProfileMs } from '../shared/callTree';
  import { importCpuProfile } from '../shared/cpuprofile';
  import { importReport, isReportFile } from '../shared/importReport';
  import type { ArtifactSymbols, ProfileRun } from '../shared/profile';
  import { buildReport } from '../shared/report';
  import { buildSpeedscopeFile } from '../shared/speedscope';
  import { persistProfile } from '../shared/storeProfile';
  import ArtifactPanel from './components/ArtifactPanel.svelte';
  import CallTree from './components/CallTree.svelte';
  import FlameGraph from './components/FlameGraph.svelte';
  import FunctionTable from './components/FunctionTable.svelte';

  type Tab = 'call-tree' | 'flame' | 'functions';

  let run = $state<ProfileRun | undefined>(undefined);
  let artifacts = $state<ArtifactSymbols[]>([]);
  let loaded = $state(false);
  let tab: Tab = $state('call-tree');
  let notices = $state<{ text: string; error: boolean }[]>([]);

  $effect(() => {
    void Promise.all([chrome.storage.local.get('profileData'), loadArtifacts()]).then(
      ([items, storedArtifacts]) => {
        run = items['profileData'] as ProfileRun | undefined;
        artifacts = storedArtifacts;
        loaded = true;
      }
    );
  });

  const totalMs = $derived(run ? totalProfileMs(run) : 0);
  const durationMs = $derived(run ? run.endedAt - run.startedAt : 0);
  const hasWasm = $derived(run !== undefined && run.roots.length > 0);

  const resolve: ResolveFunc | undefined = $derived(
    run !== undefined && artifacts.length > 0
      ? (frame) =>
          resolveFrame(
            frame,
            frame.moduleId !== undefined ? run!.modules[frame.moduleId] : undefined,
            artifacts
          )
      : undefined
  );

  function notify(entries: { text: string; error: boolean }[]): void {
    notices = entries;
  }

  function say(text: string): void {
    notify([{ text, error: false }]);
  }

  function complain(err: unknown): void {
    notify([{ text: err instanceof Error ? err.message : String(err), error: true }]);
  }

  function coverageOf(pool: ArtifactSymbols[]): string {
    if (!run) return '';
    const nodes = Object.values(run.nodes);

    const seen = new Map<
      string,
      {
        verifiedName: boolean;
        unverifiedName: boolean;
        verifiedSource: boolean;
        unverifiedSource: boolean;
        resolvedIndex: boolean;
        inferredIndex: boolean;
      }
    >();
    for (const node of nodes) {
      if (seen.has(node.label)) continue;
      const module = node.moduleId !== undefined ? run.modules[node.moduleId] : undefined;
      const r = resolveFrame(node, module, pool);
      const identified = module !== undefined && pool.some((a) => isRuntimeCompatible(a, module));
      const gotName = r.name !== node.label;
      const gotSource = r.source !== undefined && r.source !== node.source;
      const gotIndex = node.funcIndex === undefined && r.funcIndex !== undefined;
      seen.set(node.label, {
        verifiedName: gotName && !gotSource && identified,
        unverifiedName: gotName && !gotSource && !identified,
        verifiedSource: gotSource && r.inferredSource !== true,
        unverifiedSource: gotSource && r.inferredSource === true,
        resolvedIndex: gotIndex && r.inferredFuncIdx !== true,
        inferredIndex: gotIndex && r.inferredFuncIdx === true
      });
    }

    const rows = [...seen.values()];
    const total = rows.length;
    const verifiedName = rows.filter((v) => v.verifiedName).length;
    const unverifiedName = rows.filter((v) => v.unverifiedName).length;
    const verifiedSource = rows.filter((v) => v.verifiedSource).length;
    const unverifiedSource = rows.filter((v) => v.unverifiedSource).length;
    const resolvedIndex = rows.filter((v) => v.resolvedIndex).length;
    const inferredIndex = rows.filter((v) => v.inferredIndex).length;

    const idx = (n: number): string => (n === 1 ? 'index' : 'indexes');
    const line = (n: number): string => (n === 1 ? 'line' : 'lines');
    const name = (n: number): string => (n === 1 ? 'name' : 'names');

    const gained: string[] = [];
    if (verifiedSource > 0) gained.push(`verified source for ${verifiedSource}/${total}`);
    if (verifiedName > 0) gained.push(`${verifiedName} verified ${name(verifiedName)}`);
    if (resolvedIndex > 0) gained.push(`${resolvedIndex} verified function ${idx(resolvedIndex)}`);
    if (unverifiedSource > 0) gained.push(`${unverifiedSource} name-matched source ${line(unverifiedSource)}`);
    if (unverifiedName > 0) gained.push(`${unverifiedName} name-matched ${name(unverifiedName)}`);
    if (inferredIndex > 0) gained.push(`${inferredIndex} name-matched function ${idx(inferredIndex)}`);

    const header = `Across ${pool.length} stored artifact${pool.length === 1 ? '' : 's'}:`;
    const bullets =
      gained.length > 0
        ? gained.map((g) => `• ${g}`)
        : [`• no new symbols for ${total} function${total === 1 ? '' : 's'}`];
    const hint =
      verifiedSource === 0 ? ['Upload the tool’s .symbols.json to add source lines.'] : [];

    return [header, ...bullets, ...hint].join('\n');
  }

  async function importFiles(files: File[]): Promise<void> {
    const entries: { text: string; error: boolean }[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const artifact = await parseArtifact(bytes, file.name);
        await saveArtifact(artifact);
        const matched = run
          ? Object.values(run.modules).filter((m) => artifactMatchesModule(artifact, m)).length
          : 0;
        entries.push({
          text:
            `${file.name}: ${artifact.symbolQuality}, ${Object.keys(artifact.symbols).length} symbols` +
            (artifact.hash !== '' ? `, ${artifact.hash.slice(0, 8)}` : '') +
            (matched > 0 ? `, matched ${matched} module${matched === 1 ? '' : 's'}` : ''),
          error: false
        });
      } catch (err) {
        entries.push({
          text: `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          error: true
        });
      }
    }
    artifacts = await loadArtifacts();
    const coverage = coverageOf(artifacts);
    if (coverage !== '') entries.push({ text: coverage, error: false });
    notify(entries);
  }

  async function onClearArtifacts(): Promise<void> {
    await clearArtifacts();
    artifacts = [];
    say('Artifacts cleared.');
  }

  async function copyReport(): Promise<void> {
    if (!run) return;
    await navigator.clipboard.writeText(JSON.stringify(buildReport(run, artifacts), null, 2));
    say('Report copied to clipboard.');
  }

  function downloadBlob(content: string, filename: string): void {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const exportStamp = (): string =>
    run ? new Date(run.startedAt).toISOString().replace(/[:.]/g, '-') : '';

  function downloadReport(): void {
    if (!run) return;
    downloadBlob(
      JSON.stringify(buildReport(run, artifacts), null, 2),
      `wasm-profile-${run.mode}-${exportStamp()}.json`
    );
  }

  function downloadSpeedscope(): void {
    if (!run) return;
    downloadBlob(
      JSON.stringify(buildSpeedscopeFile(run, artifacts)),
      `wasm-profile-${run.mode}-${exportStamp()}.speedscope.json`
    );
  }

  async function importProfileFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const text = await file.text();
      const imported = isReportFile(text)
        ? importReport(text, file.name)
        : importCpuProfile(text, file.name);
      await persistProfile(imported);
      run = imported;
      tab = 'call-tree';
      const detail =
        imported.mode === 'tracing'
          ? `${imported.eventCount ?? 0} events`
          : `${imported.sampleCount ?? 0} samples`;
      say(
        `${file.name}: imported ${Object.keys(imported.nodes).length} WASM nodes from ${detail}.`
      );
    } catch (err) {
      complain(err);
    }
  }

  let profileInput = $state<HTMLInputElement | undefined>(undefined);

  const tabClass = (active: boolean): string =>
    `px-3 py-1.5 rounded-t border-b-2 ${active ? 'border-emerald-500 text-neutral-100' : 'border-transparent text-neutral-400 hover:text-neutral-200'}`;
</script>

<main class="mx-auto max-w-6xl p-6 space-y-4">
  <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="text-xl font-semibold">WASM Profiler</h1>
    {#if run}
      <span class="text-sm text-neutral-400">
        {run.mode} · {(durationMs / 1000).toFixed(1)}s window · {totalMs.toFixed(1)}ms in WASM
        {#if run.sampleCount !== undefined}· {run.sampleCount} samples{/if}
        {#if run.sampleIntervalMicroS !== undefined}· {run.sampleIntervalMicroS}µs interval{/if}
        {#if run.eventCount !== undefined}· {run.eventCount} events{/if}
        {#if run.targetUrl}· <span class="text-neutral-500">{run.targetUrl}</span>{/if}
      </span>
    {/if}
    <span class="grow"></span>
    <button class="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700" onclick={() => profileInput?.click()}>Import profile</button>
    <input
      bind:this={profileInput}
      type="file"
      accept=".cpuprofile,application/json"
      class="hidden"
      onchange={(e) => {
        const input = e.currentTarget;
        const file = input.files?.[0];
        input.value = '';
        void importProfileFile(file);
      }}
    />
    {#if run}
      <button class="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700" onclick={copyReport}>Copy JSON</button>
      <button class="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700" onclick={downloadReport}>Download JSON</button>
      <button class="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700" onclick={downloadSpeedscope}>Download speedscope</button>
    {/if}
  </header>

  {#if notices.length > 0}
    <div class="flex items-start gap-3 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
      <ul class="grow space-y-1">
        {#each notices as notice, i (i)}
          <li class="whitespace-pre-line {notice.error ? 'text-amber-300' : 'text-emerald-300'}">{notice.text}</li>
        {/each}
      </ul>
      <button
        class="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        onclick={() => (notices = [])}
        aria-label="Dismiss"
      >✕</button>
    </div>
  {/if}

  {#if !loaded}
    <p class="text-neutral-400">Loading…</p>
  {:else if !run}
    <div class="rounded border border-neutral-800 bg-neutral-900 p-6 text-neutral-400">
      No profile captured yet. Start a sampling run from the extension popup,
      run your workload, then stop — the viewer opens automatically. You can also
      import a DevTools .cpuprofile recording, or a JSON report exported from
      this viewer, with the button above.
    </div>
  {:else if !hasWasm}
    <div class="rounded border border-amber-900 bg-amber-950/40 p-6 text-sm text-amber-200 space-y-2">
      {#if run.mode === 'tracing'}
        <p class="font-medium">The tracing run recorded no WebAssembly calls.</p>
        <p class="text-amber-200/80">
          Common causes: the page loaded its module before tracing started (start tracing
          first — it reloads the page), the module was loaded through an unsupported path
          (see below), or the workload never ran. Instrumentation only sees the four
          mainstream instantiation paths.
        </p>
      {:else}
        <p class="font-medium">The profile contains no WebAssembly frames.</p>
        <p class="text-amber-200/80">
          Common causes: sampling started after the workload finished, the workload was too
          short for the {run.sampleIntervalMicroS ?? 1000}µs sampling interval, or the WASM runs
          in a worker thread (not yet supported). Try starting sampling first, then running a
          longer workload.
        </p>
      {/if}
      {#if run.traceIssues}
        <ul class="list-disc pl-5 text-amber-200/80">
          {#each run.traceIssues as issue (issue)}<li>{issue}</li>{/each}
        </ul>
      {/if}
    </div>
  {:else}
    {#if run.traceIssues || run.unbalancedEvents !== undefined}
      <div class="rounded border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200 space-y-1">
        {#each run.traceIssues ?? [] as issue (issue)}<p>{issue}</p>{/each}
        {#if run.unbalancedEvents !== undefined}
          <p>
            {run.unbalancedEvents} unbalanced trace event{run.unbalancedEvents === 1 ? '' : 's'}
            (traps or exceptions unwound past exit hooks); affected times are approximate.
          </p>
        {/if}
      </div>
    {/if}
    <ArtifactPanel {artifacts} onimport={importFiles} onclear={onClearArtifacts} />

    <nav class="flex gap-1 border-b border-neutral-800 text-sm">
      <button class={tabClass(tab === 'call-tree')} onclick={() => (tab = 'call-tree')}>Call tree</button>
      <button class={tabClass(tab === 'flame')} onclick={() => (tab = 'flame')}>Flame graph</button>
      <button class={tabClass(tab === 'functions')} onclick={() => (tab = 'functions')}>Functions</button>
    </nav>

    {#if tab === 'call-tree'}
      <CallTree {run} {totalMs} {resolve} />
    {:else if tab === 'flame'}
      <FlameGraph {run} {totalMs} {resolve} />
    {:else}
      <FunctionTable {run} {totalMs} {resolve} />
    {/if}
  {/if}
</main>
