# Spritewright native port assessment

Assessed 18 October 2026 against Spritewright `4ba76c7` and zig-game-lab `57cea52`.

**Recommendation: use the same native/web architecture as zig-game-lab, with a shared Zig editor core and a proper UI toolkit. Budget 2–4 engineering weeks for a useful desktop prototype and 10–16 engineering weeks for current-feature parity on Linux, Windows and the web.** Additional platforms need their own integration and testing. These are planning estimates for one experienced engineer working full time, not measured implementation times or delivery commitments.

The game provides a working build, rendering and distribution reference. It does not provide the editor's UI, document model or desktop integrations. Cloudflare deployment is a small part of the project; rebuilding the browser-provided application behavior is the substantial part.

**What the repositories actually do**

zig-game-lab uses Zig 0.17, SDL3's GPU API and Slang shaders. Its native build supplies SPIR-V shaders, making Vulkan the applicable backend. Its browser build is separate: Zig compiles to `wasm32-freestanding`, while JavaScript supplies WebGL2 rendering, browser input, storage and audio. The browser does not run the native SDL/Vulkan build. See [build.zig](../../zig-game-lab/build.zig), [native renderer](../../zig-game-lab/src/gfx.zig), [Wasm host](../../zig-game-lab/src/web.zig) and [browser host](../../zig-game-lab/web/main.js).

The game's [release workflow](../../zig-game-lab/.github/workflows/release.yml) builds Linux, Windows and web outputs. Its [site script](../../zig-game-lab/tools/site.sh) assembles the web app and downloadable native ZIPs, and [wrangler.jsonc](../../zig-game-lab/wrangler.jsonc) deploys them through a static-assets Worker. Cloudflare serves the files; editor/game execution happens on the user's machine. This matches Cloudflare's [static-assets hosting model](https://developers.cloudflare.com/workers/static-assets/).

Spritewright currently has 4,121 lines in [spritewright.js](../spritewright.js), including compact algorithms, embedded CSS, HTML templates and application behavior. Its `mount()` implementation starts at line 1,725 and contains roughly 2,390 lines of UI, interaction and orchestration. These line counts describe where the code lives; they are not a conversion-rate estimate. The compact implementation contains considerably more functionality than the file size suggests.

The good starting point is the existing `core` exports and `Doc` model: packed RGBA pixels, brush and shape algorithms, selections, transformations, compositing, layers, history, animation operations and palette calculations. Much of this can be translated and checked independently of a UI. Some tool behavior and linked-document coordination still live inside `mount()` and need extraction.

The current UI depends on DOM controls, CSS layout, Canvas2D, browser events, dialogs, IndexedDB, localStorage, clipboard APIs and the File System Access API. Those facilities do not become native widgets or native services by compiling the algorithms to Zig.

**Reuse and replacement**

| Area | Useful existing work | Work required |
| --- | --- | --- |
| Build and distribution | Game's Zig/SDL build, Linux/Windows packaging, Wasm target, CI and Cloudflare site assembly | Adapt names, assets and dependencies; add editor checks and future platform packages |
| Pixel algorithms | Spritewright's exported functions and existing tests | Translate to Zig; preserve rounding, alpha, selection and transformation behavior |
| Document state | `Doc`, layers, snapshots, base/saved comparisons, linked layers | Explicit ownership and allocation; command handling; cross-frame history and recovery |
| Canvas rendering | Game's nearest-neighbour sampling, texture upload and GPU initialization patterns | Editable textures, clipping, arbitrary canvas dimensions, zoom/pan, overlays and previews |
| Editor UI | Existing behavior and layout as the specification | Rebuild menus, panels, dialogs, text fields, palettes, frame strips, shortcuts and focus handling |
| PNG and exports | Spritewright's codecs and format tests | Shared native/Wasm codecs, metadata support, GIF, ZIP and sheet JSON |
| Project access | Existing source abstraction, scanning rules and atomic-save behavior | Native filesystem adapter; async browser adapter; error and conflict handling |
| GitHub | REST workflows and existing auth Worker | Native HTTP, credential storage and a desktop login callback; preserve PR/fork/branch semantics |
| Persistence | Draft record semantics and project IDs | Native recovery storage and migration; browser storage remains a host integration |
| Tests | Existing unit, API and browser interaction tests | Cross-language fixtures and native interaction coverage; DOM tests cannot directly exercise a canvas UI |

The game renderer is tailored to a fixed 640×360 scene and startup-loaded art atlas. An editor needs resizable, DPI-aware panels and dynamically changing document textures. Reuse the architecture and selected helpers, rather than treating the game's renderer or bitmap font as a finished editor framework.

Keep authoritative document pixels on the CPU and use the GPU for display. Saving from the document buffer preserves channels independently of display blending or GPU readback. Start with straightforward texture uploads when documents change; optimize dirty regions only if measurements justify it. Vulkan is not needed to accelerate every pencil stroke.

**Proposed architecture**

```text
Shared Zig editor core
  documents, layers, history, tools, selections, palettes, codecs
                         |
Shared editor UI and commands
                 /                   \
Native host                           Browser host
SDL3 + SDL_GPU                        Wasm + web rendering backend
filesystem, dialogs, clipboard        JS file/clipboard/storage adapters
HTTP, credential storage              fetch + existing auth service
                 \                   /
               CI assembles site + downloads
                    Cloudflare hosting
```

Define host operations explicitly: open/read/write files, list projects, persist recovery data, access the clipboard, make HTTP requests and open external URLs. Browser operations are asynchronous, so use completion events or request IDs in the shared application. Avoid a synchronous native-only API that later prevents browser reuse.

**DVUI is the first UI toolkit worth trialling.** Its current README reports Zig 0.17 support, SDL3GPU and web backends, and lists Fizzy, a pixel-art editor, among its users. The SDL3GPU source includes SPIR-V, Metal and DXIL shaders, which could avoid writing a separate UI renderer. This is evidence of suitability, not validation with Spritewright's requirements. Pin a tested revision and verify text input, clipping, nearest-neighbour images, touch, accessibility and both build targets. Sources: [DVUI README](https://github.com/david-vanderson/dvui), [SDL3GPU backend](https://github.com/david-vanderson/dvui/blob/main/src/backends/sdl3gpu.zig).

Dear ImGui is an alternative with an official [SDL3/SDL_GPU example](https://github.com/ocornut/imgui/tree/master/examples/example_sdl3_sdlgpu3), but its C++ integration and browser build need separate evaluation. Neither toolkit automatically ports the current UI. Building all widgets and text editing ourselves would substantially increase the estimate.

An incremental route can retain the existing browser UI while moving algorithms into a Zig/Wasm core and building the native UI beside it. That protects current browser users, but temporarily means maintaining two UIs. A shared Zig UI is the eventual route to minimizing that duplication. A system-webview wrapper could reuse more HTML, but would retain browser-based UI behavior and is outside the intended native-rendered direction.

**Specific compatibility work that must be budgeted**

1. **PNG fidelity and layers.** The game's [PNG decoder](../../zig-game-lab/src/png.zig) handles non-interlaced, 8-bit RGB/RGBA assets. Spritewright also handles indexed/grayscale variants, transparency chunks and text metadata, and writes `.layers.png` sidecars. The game's decoder is not a replacement for those capabilities. Verify RGBA channel equality, including alpha 250 and RGB under fully transparent pixels; retain layer names, opacity, visibility and link metadata. Preserve Spritewright's current supported formats without silently reducing them.
2. **Native editing behavior.** SDL provides [file dialogs](https://wiki.libsdl.org/SDL3/SDL_ShowOpenFileDialog), [clipboard facilities](https://wiki.libsdl.org/SDL3/CategoryClipboard) and [pen events](https://wiki.libsdl.org/SDL3/CategoryPen). They still need integration and platform testing. Include image clipboard formats, drag-and-drop, Unicode filenames, text composition/IME, DPI changes, pen/finger distinction and keyboard focus. Native file saving should retain atomic writes and layer-sidecar behavior.
3. **Recovery and state.** Native recovery must replace IndexedDB persistence while preserving the distinction between working changes, saved files and branch originals. Account for large sheets and full-layer undo snapshots; a desktop build does not make memory costs disappear. Preserve animation timings, notes and project settings currently held in browser storage.
4. **GitHub sign-in.** The current [Worker callback](../worker/index.js) returns credentials through `window.opener.postMessage`. A native application has no opener page. Use a deliberate desktop flow through the system browser, such as a validated loopback handoff with a one-time exchange, and OS credential storage. The current loopback-origin allowance alone does not implement that flow. Keep client secrets on the server. Git history can initially use an installed `git`, as the local server does today; bundling Git or replacing it is additional scope.
5. **Changing the web origin.** The current site is deployed on GitHub Pages; its auth Worker allows `https://snowu.github.io`. A Cloudflare site needs the new origin allowed and install/service-worker paths checked. Browser drafts and sessions do not automatically move across origins. Provide an export/import or migration path before replacing the existing URL.
6. **Embedding and CLI compatibility.** Spritewright is also an npm library and local CLI, with `mount()`, controller methods and exported helpers. A Wasm build introduces loading and asynchronous initialization that the current script does not require. Keep the existing package during migration or explicitly budget a compatible wrapper. Replacing the Node CLI and preserving every synchronous JavaScript helper API are separate deliverables from the desktop application.

**Effort estimate**

Assumptions: one experienced engineer familiar with these projects; reuse of an existing UI toolkit; Linux/Windows first; access to real target machines; current features rather than new blend modes or document formats. Estimates include integration and testing. Toolkit suitability and native/web input behavior are the largest unresolved variables.

| Milestone | Estimated effort | Completion criterion |
| --- | --- | --- |
| Feasibility trial | 3–5 engineering days | Same small editor core builds native and web; open PNG, draw, undo, zoom and save; usable text field and resizable canvas |
| Useful desktop prototype | 2–4 engineering weeks total, including trial | Linux/Windows local-file editing, pencil/eraser/fill, palette, zoom/pan, undo/redo and lossless PNG save; basic recovery |
| Current editor feature parity on Linux/Windows/web | 10–16 engineering weeks total | Layers and linked frames, selections, animation/export tools, project modes, GitHub workflows, recovery and interaction QA |
| macOS support | Approximately 1–3 additional engineering weeks | Metal-capable renderer, builds, app bundle/signing/notarization setup and Mac input/filesystem testing |
| Android support | Approximately 3–6 additional engineering weeks after shared app is stable | SDK/NDK packaging, document access, lifecycle/recovery, keyboard/stylus integration and device testing |
| iOS/iPadOS support | Approximately 4–8 additional engineering weeks after shared app is stable | Apple build/signing, document access, lifecycle/recovery, touch/Pencil integration and device testing |

The first three rows are cumulative alternatives, not additive phases. Platform additions can share some work; they are not promises that every device or store-distribution requirement fits the range. Account enrollment or external review waiting time is excluded. Mobile estimates assume adapting the existing touch workflow; a substantial mobile redesign adds scope.

The 10–16 week range broadly allocates 2–3 weeks to core/codecs, 3–5 to editor UI and rendering, 2–3 to native project/GitHub/persistence integrations, 1–2 to browser integration and distribution, and 2–3 to migration and cross-platform regression work. This assumes retaining the current JavaScript package/CLI where needed during migration. A complete replacement of those public interfaces needs its own acceptance criteria and estimate.

Moving the existing web app to Cloudflare alone would be roughly 1–3 engineering days, including deployment configuration, auth-origin changes and a basic migration plan. It would not create a native application. The new editor's web host, file access and persistence work is already included in the larger estimate.

The game currently packages only x86-64 Linux and Windows. It supplies only SPIR-V shaders. SDL_GPU supports Metal and Direct3D as well, but each backend needs suitable shader formats; compiling for macOS does not by itself convert those shaders. DVUI may supply the UI side, while any custom canvas shader still needs equivalent coverage. See [SDL_GPU's backend and shader requirements](https://wiki.libsdl.org/SDL3/CategoryGPU). ARM64 builds and device testing are also separate from the existing x86-64 packaging recipe.

**Recommended first implementation milestone**

Spend the first 3–5 days on a small editor inside this repository with a pinned Zig/UI dependency set. Prove Linux, Windows and browser builds, resizable UI, editable pixel textures, text input and the complete open → edit → undo → save → reopen path. Include a partially transparent PNG and a layered fixture. The trial can use a narrow format subset, provided that limitation is explicit; it is not the production codec acceptance test.

Compare raw pixels and layer metadata against fixtures produced by the existing JavaScript implementation. Exercise a large sheet and high-DPI display, and check that idle rendering does not unnecessarily run at game-loop speed. Check a real pen device before treating input support as solved. Re-estimate after this trial, particularly if the toolkit requires backend changes or the web host cannot preserve editing behavior.

If it passes, implement the document/core and native local-project workflow first, then advanced tools and GitHub integration. Keep the existing browser application available until the replacement passes feature and data-migration checks. Adapt the game's release pipeline once useful native and web builds exist; hosting should not drive the core design.

**Verification performed**

Inspected both local repositories' source, build configuration, packaging and deployment workflows; checked upstream SDL, DVUI, Dear ImGui and Cloudflare documentation. Ran Spritewright's existing `npm test`: **111 tests passed** after running outside the sandbox so local HTTP fixtures could bind. No application code was changed, no new Zig editor or toolkit integration was built, and no GPU/mobile performance claim was measured. The game's live deployment and all target devices were not independently exercised during this assessment.

The assessment supports proceeding with a small feasibility trial. It does not yet establish production readiness for a particular UI toolkit or platform.
