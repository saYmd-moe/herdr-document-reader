# Document Reader

A read-only document pane for Herdr App: PDF directly, and Word, Excel, PowerPoint, or OpenDocument through LibreOffice conversion. Documents can be local or on a herdr-core machine. It has single-page and continuous views, mouse controls, Zathura-inspired keys, search, and automatic reload. It never embeds a Zathura or LibreOffice window and never docks a permanent sidebar.

![Document Reader](preview.png)

## What you see

All colors come from `theme()`; the UI follows Herdr's appearance and zoom.

- **Header, 42px:** the source filename, an optional `Auto-refreshing…` indicator, and a `?` help button. A 1px `border` separates it from the toolbar.
- **Toolbar, 40px:** previous page, a 58px page-number input, total pages, next page, `−`, zoom percentage, `+`, `Width`, `Page`/`Scroll`, `Find`, `Reload`, and `Zathura` or `LibreOffice`. The strip scrolls horizontally when narrow.
- **Body:** `canvas` behind the document. A loaded page is a native `image()` with 3px corners and a medium shadow.
  - **Single page:** fit page by default, centered when it fits, with a 24px minimum edge around an enlarged page. Empty pages show a rendering message or the render error.
  - **Continuous:** pages in one virtual list, 16px gaps, width fit to the viewport and adjusted by zoom. A horizontal scroll area handles enlarged pages and a native vertical scrollbar tracks the list.
- **Footer, at least 24px:** current/total page, single or continuous mode, search status or reload errors, and document kind/zoom. Remote documents also show the source machine. The default hint is `Auto-reload on · mouse wheel · ? for keys`.
- **Search dialog, 540×154:** a focused native input, Previous, Next, and Close. Enter finds the next matching page, Shift+Enter the previous one.
- **Help dialog, 760×500:** two columns covering navigation, reading, mouse behavior, and Herdr shortcuts. `?`, `q`, or Escape closes it.
- **Errors:** initial errors replace the body and offer Try again. A failed reload keeps the old document visible and reports the error in the footer.

## How it behaves

### Opening and documents

- `mod.json` is `{ "place": "none", "title": "Document Reader", "focusable": true }`; it adds no layout block by itself.
- Open with `tab.new` or `pane.split`, `mod: "document-reader"`, and `props: { file: "/absolute/path", page: 8, on: null }`. `page` is optional and defaults to 1. `on` is a machine name from `hc machine ls`, or null/omitted for a local document.
- PDF opens directly. `.doc`, `.docx`, `.odt`, `.rtf`, `.xls`, `.xlsx`, `.ods`, `.ppt`, `.pptx`, and `.odp` convert to a cached PDF with LibreOffice. Unsupported extensions and password-protected PDFs show explicit errors.
- Local pages render at 1800px longest edge; remote pages default to 1400px to reduce transfer size. Both use 3600px above 175% zoom. Only the visible/current page, one before, and four after are requested. A lower-quality page stays visible while its sharper replacement renders.
- Local `Zathura`/`LibreOffice` opens the source externally. Remote external-open reports that a local copy is needed rather than accidentally opening an identically named local file.

### Remote rendering and transfer

- `openDocument(file, on)` obtains the source signature and PDF metadata through `exec(..., { on })`. A cache key hashes machine, source path, high-resolution mtime, and byte size, preventing collisions between machines and file versions.
- Remote PDF renders directly with `pdftoppm`. Remote Office converts with `soffice` into `~/.cache/herdr-document-reader/<key>/document.pdf` on that machine.
- Remote pages render on demand and download only when shown or prefetched. Downloads use 2 MiB binary chunks: remote `dd` reads a byte range and pipes it to `base64 -w0`.
- Base64 is decoded locally with an `Int16Array` reverse lookup table into a preallocated `Uint8Array`. This avoids repeated `String.indexOf` scans and large JavaScript number arrays. Decoded byte counts and final PNG signatures are validated.
- The complete image is written to a local temporary file and moved atomically into `data/document-reader/<key>/`. The remote page remains in the remote cache. Remote cache directories older than 14 days are pruned; local inactive entries also expire after 14 days or beyond 60 versions.
- Remote search runs `pdftotext` on the source machine. It does not download every page image.
- A real herdr-core `--on` transport is required; there is no special loopback-only production path and no original-document download fallback when remote tools are missing.

### Automatic reload

- Local `watchFolder(dirname(source))` watches the source; events are debounced by 450ms. Local and remote documents both use a two-second metadata check; remote documents do not start a local folder watch.
- The cache signature includes machine, source path, high-resolution modification time, and byte size.
- The current document stays on screen while conversion and the first new page finish. The new version then replaces it atomically. The visible/current page, single/continuous mode, fit mode, and zoom are preserved; a page beyond the new count is clamped.
- An event arriving during conversion queues another reload. Conversion, transfer, render, or connection failure does not blank the previous document.
- Office uses an isolated LibreOffice profile and sets `TMPDIR` to its temporary work directory. This avoids both interference with a running LibreOffice GUI and systems whose `/tmp` has a small user quota.

### Keyboard and Herdr integration

When the reader root has focus:

- `j`, Down, `J`, PageDown, Space: next page. `k`, Up, `K`, PageUp, Shift+Space: previous page. A numeric prefix repeats the step.
- `Ctrl-d`/`Ctrl-u`: half-screen down/up. `Ctrl-f`/`Ctrl-b`: page down/up.
- `gg`: first page, `G`: last page, and `12G`: page 12. Digits form the prefix; `0` alone is fit-page instead.
- `h`/Left and `l`/Right pan an enlarged page.
- `+`/`-`: zoom by 1.25×, from 25% to 500%. `0` or `a`: fit page. `s`: fit width. `c`: switch single/continuous, retaining the visible page.
- `/`: search dialog. `n`/`N`: next/previous matching page. `r`/`R`: reload. `o`: local external open. `q`: close the reader pane. `?`: help.
- The handler stops propagation only for keys it consumes. Other modified chords continue to Herdr; application zoom, pane navigation, tabs, and the command palette are not replaced.
- Merge a `mod:document-reader` key section for `ctrl-shift-f` → `document-reader.search` and `ctrl-shift-r` → `document-reader.reload`.
- `nextCommand()` also accepts `next`, `prev`, `zoom-in`, `zoom-out`, `fit`, `fit-width`, `continuous`, `reload`, `search`, `search-next`, `search-prev`, `help`, `open`, and `search:<uri-escaped query>`.

### Mouse

- Toolbar controls have hover states, tooltips, and accessibility labels. Clicking one returns keyboard focus to the reader.
- In single-page mode the wheel turns pages after a small threshold. In continuous mode the native virtual list handles the wheel.
- Ctrl/Cmd+wheel zooms around the pointer in single-page mode. An enlarged page pans with Shift+wheel or by dragging; drag ends on release or pointer exit.
- Double-click toggles fit-page and 200% at the pointer. Clicking a page in the continuous list selects it and focuses the reader.

### Search

- `pdftotext` extracts UTF-8 text from the direct or converted PDF, locally or remotely. Case-insensitive search records matching page numbers and total occurrences.
- A new search chooses the first matching page at/after the current page, or before it for reverse search, wrapping at the ends. Further `n`/`N` cycles matching pages.
- The footer shows `N/M matching pages · K matches` or `No matches`. Search jumps pages; it does not draw text highlights in the raster.

## Built from

```text
mods/document-reader/
  mod.json
  main.js
  documents.js
README.md
RECIPE.md
preview.png
```

- `main.js` is the default-exported `View`: reader, search dialog, and help dialog roles. It owns focus handles, `InputState`, `VirtualListScrollHandle`, page state, render generations, watchers, remote polling, and command dispatch.
- Native UI: `div`, `image`, `v_flex`, `h_flex`, `v_virtual_list`, `Scrollbar`, `Input`, and `InputState`. No DOM, WebView, Node runtime, `setTimeout`, or host changes.
- Herdr APIs: `props`, `theme`, `settings`, `exec`, `run`, `openOverlay`, `closeOverlay`, `shared`/`setShared`, `watchFolder`, and `nextCommand`.
- `documents.js` identifies formats, computes local/remote signatures, converts Office files, reads PDF metadata, renders and transfers PNG pages, extracts text, and prunes caches.
- External programs: `env`, `soffice`, `pdfinfo`, `pdftoppm`, `pdftotext`, `stat`, `dd`, `base64`, `mkdir`, `mv`, `rm`, `find`, `pwd`, `sh`, and optionally `zathura`/`libreoffice`.
- Local cache: `data/document-reader/<machine-source-version-hash>/`. Remote cache: `~/.cache/herdr-document-reader/<machine-source-version-hash>/` on the source machine.
- Shared keys: `document-reader.active` protects open document versions from local pruning, and `document-reader.command.<reader-id>` forwards search-dialog submissions.
- `preview.png` is an actual Herdr window capture cropped to the reader, showing page 8 of an 80-page PDF.

## Watch out

- Write `mod.json` with `"place": "none"` before letting Herdr discover a new folder. A folder first seen without its manifest can be docked using Herdr's default placement; adding the manifest later does not remove that layout block.
- Herdr 0.1.15's restricted `fs/promises` does not expose every Node method. Use argument-separated `exec` calls for `stat`, `mv`, and `rm` rather than assuming Node's `fs.stat`, `fs.rename`, or `fs.rm` exists.
- LibreOffice can fail to export if its temporary directory is on a quota-limited `/tmp`. Set `TMPDIR` with `env` and use a separate `UserInstallation` for each conversion, locally and remotely. Always clean the temporary work directory.
- Pass every path as an argv item, not interpolated shell text. The only shell snippets receive their paths in numbered arguments. Source documents are never edited.
- `image()` takes paths inside Herdr's home, so even a remote page must be downloaded into the local cache before display.
- Keep Base64 chunks below Herdr's 8 MiB `exec` output limit. The 2 MiB binary chunks produce about 2.67 MiB of text. A naïve per-character `String.indexOf` decoder can stall on these chunks; use the reverse lookup table.
- Virtual-list row renderers cannot register handlers. Use the list's `on_item_click`; page requests run from the 250ms data pump, not from layout.
- `on_size_change` measurements are divided by `settings().zoom` before computing fit sizes. Keep all dimensions in Herdr's zoom-1 coordinate system.
- Password-protected PDFs, native spreadsheet cells, PDF links/forms/annotations, animations, SyncTeX, highlighted search overlays, remote external-open, and original-document download fallback are not implemented.
- The initial `herdr-app check` does not execute deferred page loads or physical input. Verify those in a real window and through a real `--on` connection. A temporary `--via` machine can exercise that transport without SSH, but it does not prove performance over a slow WAN.

## Done when

- `herdr-app check mods/document-reader` passes and `herdr-app status` has no mod, key, or layout errors.
- Installing the folder creates no permanent sidebar or layout block.
- Local PDF and Office files still open and render after the remote changes.
- A real remote `--on` PDF opens with the machine shown in the footer; nearby pages are downloaded at 1400px.
- Real remote Word, Excel, and PowerPoint files convert and display. The reference remote build showed 1 Word page, 87 Excel pages, and 1 PowerPoint slide.
- Remote search and next-match commands work, and replacing a remote-open 80-page PDF with a one-page PDF creates a new version and displays page 1/1 automatically.
- A remote PNG larger than 2 MiB downloads through multiple chunks and is byte-identical to the remote original. The reference transfer was 3,930,766 bytes in two chunks.
- The search and help dialogs open as native Herdr overlays, and Herdr's command palette still opens above the reader.
- Temporary machines, test spaces, screenshots, source copies, and test caches are removed afterward; the user's previous workspace is restored.
