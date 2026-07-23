export const ENTER_HOOK = '__profiler_enter_hook';
export const EXIT_HOOK = '__profiler_exit_hook';
export const ORIG_SUFFIX = '__profiler_orig';

export const INSTRUMENTED_PAGE_NOTICE =
  'This profile came from a page whose WebAssembly was rewritten for tracing. ' +
  'Timings include enter/exit hook overhead, and every instrumented function appears ' +
  'twice — a wrapper under its original name plus the real body as ' +
  `\`name${ORIG_SUFFIX}\`. Reload the page to sample the original module.`;
