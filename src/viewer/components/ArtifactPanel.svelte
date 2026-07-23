<script lang="ts">
  import { artifactKey } from '../../shared/artifacts';
  import type { ArtifactSymbols } from '../../shared/profile';

  let {
    artifacts,
    onimport,
    onclear
  }: {
    artifacts: ArtifactSymbols[];
    onimport: (files: File[]) => void;
    onclear: () => void;
  } = $props();

  let fileInput: HTMLInputElement;
</script>

<section class="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm">
  <div class="flex items-center gap-3">
    <span class="font-medium">Symbol artifacts</span>
    <button
      class="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
      onclick={() => fileInput.click()}
    >Import .wasm / .json</button>
    {#if artifacts.length > 0}
      <button
        class="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700"
        onclick={onclear}
      >Clear all</button>
    {/if}
    <input
      class="hidden"
      type="file"
      multiple
      accept=".wasm,.json,.map"
      bind:this={fileInput}
      onchange={(e) => {
        const files = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = '';
        if (files.length > 0) onimport(files);
      }}
    />
    <span class="text-xs text-neutral-500">
      Upload the served .wasm for names; upload symbol-map JSON (from the symbols tool) for source lines.
    </span>
  </div>
  {#if artifacts.length > 0}
    <ul class="mt-2 space-y-1">
      {#each artifacts as artifact (artifactKey(artifact))}
        <li class="flex flex-wrap items-baseline gap-x-3 text-xs text-neutral-400">
          <span class="font-mono text-neutral-200">{artifact.uploadName ?? artifact.filename}</span>
          <span>type: {artifact.symbolQuality}</span>
          {#if artifact.uploadName !== undefined && artifact.uploadName !== artifact.filename}
            <span>describes {artifact.filename}</span>
          {/if}
          <span class="font-mono">{artifact.hash.slice(0, 8) || 'no hash'}</span>
          {#if artifact.functionCount !== undefined}<span>{artifact.functionCount} functions</span>{/if}
          <span>{Object.keys(artifact.symbols).length} symbols</span>
          {#if (artifact.sources?.length ?? 0) > 0}<span>{artifact.sources!.length} source files</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
