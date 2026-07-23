<script lang="ts">
  import type { SymbolQuality } from '../../shared/profile';

  let { quality }: { quality: SymbolQuality } = $props();

  const styles: Record<SymbolQuality, string> = {
    debug: 'bg-emerald-950 text-emerald-300',
    name: 'bg-sky-950 text-sky-300',
    'export-import': 'bg-violet-950 text-violet-300',
    fallback: 'bg-amber-950 text-amber-300',
    stripped: 'bg-neutral-800 text-neutral-400'
  };
</script>

<span class="rounded px-1.5 py-0.5 text-xs {styles[quality]}">{quality}</span>
