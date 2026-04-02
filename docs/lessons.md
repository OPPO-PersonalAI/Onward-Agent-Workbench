# Lessons Learned

## 2026-03-26: Multi-terminal output performance optimization and end-to-end stress testing

### 1. Test methods must reflect real user scenarios instead of only system metrics
- **Problem**: The initial evaluation only measured terminal output FPS and `xterm.write` latency, then concluded that performance was fine (`fps=32`, `writeMax=0.4ms`), even though typing still felt visibly laggy to the user.
- **Cause**: The analysis mixed up terminal output performance with user input performance. The real pain point was Prompt input responsiveness while terminals were flooding output, not whether terminal rendering itself was smooth.
- **Lesson**: Performance testing must start from the user experience. First identify which operation feels slow, then measure the latency of that operation. Internal metrics such as FPS or write duration are diagnostic signals, not acceptance criteria.

### 2. Stress-test intensity must match real load instead of stopping at a light sample
- **Problem**: The initial stress test only ran for 30 seconds and 25,000 lines, far below the sustained high-throughput scenario produced by Claude Code in real usage.
- **Cause**: The test optimized for fast feedback instead of representing real load characteristics. Claude Code can produce continuous output across multiple terminals for a long time, which is far heavier than a simple loop.
- **Lesson**: Stress tests should run for at least 10 to 20 minutes and use an infinite loop such as `while ($true)` to simulate sustained output. Short tests only expose startup issues and will miss long-run problems such as memory accumulation, GC pressure, and resource leaks.

### 3. Do not rely on overly indirect or fragile end-to-end test methods
- **Problem**: The attempt to automate everything through `app-state.json`, API calls, and background process tricks repeatedly ran into file locks, process-management issues, and terminal ID formatting problems such as stray `\r`.
- **Cause**: The approach aimed for full automation without considering the current infrastructure limits. The API server does not expose terminal creation or layout switching, so mutating state files directly is brittle.
- **Lesson**: Prefer the most direct path. Let the user perform the UI-only step when necessary, then drive the rest through the API. Do not try to bypass every UI step with hacks when the platform does not support it cleanly.

### 4. When editing `useEffect`, always evaluate cleanup impact on initialization flow
- **Problem**: After adding a `setVisibility` effect, the cleanup ran when `visibleTerminals` changed from 1 to 6 terminals, set the old terminals to `visible=false`, and disposed the WebGL context. The next effect immediately recreated WebGL with `visible=true`, and that dispose-plus-create cycle within one frame froze the 6-panel initialization.
- **Cause**: The implementation did not fully account for React `useEffect` cleanup timing. When dependencies change, cleanup runs before the new effect, and that ordering is dangerous for cleanup logic that releases resources such as WebGL contexts.
- **Lesson**: Be especially careful with cleanup in effects that touch GPU resources, DOM state, or other side effects. If cleanup releases a resource that the new effect will immediately recreate, the cleanup may be unnecessary and harmful.

### 5. Performance optimization must start at the source of the data flow instead of patching only the tail
- **Problem**: The first optimization only throttled renderer-side writes to 50ms. That reduced writes per second from 18,000 to 96, but user input latency barely improved (`2212ms` versus the original `1900ms`).
- **Cause**: Renderer-side throttling reduced `terminal.write()` frequency, but the main process still emitted IPC messages every 16ms to every terminal. The renderer main thread still paid the cost of each IPC callback, including map lookups, queue pushes, and scheduling checks.
- **Lesson**: Follow the entire data path from source to sink: `PTY -> TerminalDataBuffer(main) -> IPC -> renderer callback -> pendingData -> rAF -> terminal.write()`. Optimizing only the final write step leaves upstream costs in place. IPC frequency and renderer write frequency both need to be addressed.

### 6. Process management must use exact names and never wildcards
- **Problem**: Using wildcard matches with `taskkill` and `Get-Process` risked terminating unrelated user processes.
- **Cause**: The commands optimized for convenience and ignored the possibility that multiple Onward variants could be running at the same time.
- **Lesson**: This is now a hard rule. Use exact process names only with `taskkill`, `Get-Process`, and `pkill`. On Windows, prefer `wmic process where "name='ExactName.exe'"` for precise querying and control.

### 7. Windows bash variable and PowerShell escaping requires extra care
- **Problem**: When PowerShell commands were sent through `curl`, bash expanded PowerShell variables such as `$i` and `$_` as bash variables, which broke command delivery in most terminals. Python-generated terminal IDs also contained `\r`, which corrupted URL construction.
- **Cause**: Cross-shell invocation chains such as `bash -> curl -> JSON -> PowerShell` introduce multiple escaping layers, and each layer can rewrite or consume special characters.
- **Lesson**: When commands cross shells, prefer heredocs such as `<< 'EOF'` or file-based payloads to avoid multi-layer escaping bugs. Always normalize external command output with `tr -d '\r'` when Windows line endings may be present.

## 2026-04-02: Markdown migration regressions and incomplete first-pass fixes

### 1. Migration review must include shell-level files such as `index.html`, not only component logic
- **Problem**: Markdown images appeared to be wired correctly in the renderer and worker, but the packaged app still failed to display them.
- **Cause**: The migration review focused on `ProjectEditor.tsx` and `markdownPreviewWorker.ts`, but did not compare the source project's `index.html`. The source project allowed Markdown images through CSP with `img-src 'self' data:`, while this repo's initial `index.html` omitted `img-src`, so the browser blocked image rendering even when the generated HTML was correct.
- **Lesson**: When porting a working feature from another project, compare the full execution path end to end: HTML shell and CSP, preload boundaries, renderer state, worker output, and DOM behavior. Do not assume root-level files match the source project unless they have been explicitly diffed.

### 2. End-to-end validation must check visible behavior, not only generated HTML
- **Problem**: The first repair looked successful because the Markdown preview HTML already contained `<img src="data:image/...">`, yet the user still saw broken images.
- **Cause**: The verification standard stopped at internal state and rendered HTML strings. That proved the data path was partly correct, but it did not prove that the browser actually loaded and displayed the image.
- **Lesson**: For UI rendering bugs, autotests must verify the user-visible outcome. In this case the correct assertion is not just "the HTML contains an `<img>` tag" but also "the preview DOM contains images whose `naturalWidth > 0` and whose broken count is zero."

### 3. When a user says the bug still exists, assume layered failures until disproven
- **Problem**: The first Markdown image fix restored the missing re-render after image caching, but the overall issue still remained because a second independent failure was still active.
- **Cause**: The debugging process converged too early on a plausible internal cause and treated that as the whole bug. In reality there were two separate regressions: the missing re-render path and the missing CSP `img-src` allowance.
- **Lesson**: If a user reports that the visible bug still exists after a fix, immediately test for stacked regressions instead of defending the first explanation. Re-check every layer of the pipeline and look for independent blockers that can mask each other.
