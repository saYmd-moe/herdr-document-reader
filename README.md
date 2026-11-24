# Herdr Document Reader

A native, read-only PDF and Office document reader for [Herdr App](https://herdr.dev), with local and remote rendering through herdr-core. It uses Herdr's mod APIs and GPUI elements—no WebView, browser panel, host patch, or embedded external window.

![Herdr Document Reader showing a PDF](preview.png)

## Features

- PDF, Word, Excel, PowerPoint, and OpenDocument files.
- Documents on this computer or on machines configured with `hc machine add`.
- Single-page and continuous scrolling modes.
- Mouse toolbar, wheel navigation, Ctrl+wheel zoom, drag panning, and double-click zoom.
- Zathura-inspired Vim keys that leave Herdr's own Ctrl/Cmd/Alt shortcuts alone.
- Page-number input, text search with match counts and page jumping.
- Automatic reload when the source file changes, preserving the current view when possible.
- Optional external opening in Zathura for local PDFs or LibreOffice for local Office documents.
- Native Herdr themes, panes, tabs, overlays, commands, and focus handling.

## Requirements

### Local documents

- Linux with Herdr App 0.1.15 (the tested version).
- Poppler utilities: `pdfinfo`, `pdftoppm`, and `pdftotext`.
- LibreOffice for Office conversion (`soffice`); PDF viewing does not need LibreOffice.
- Zathura is optional and used only by the external-open action.

### Remote documents

The remote machine needs:

- A working herdr-core connection shown by `hc machine ls`.
- Poppler utilities for PDF metadata, rendering, and search.
- LibreOffice for remote Office conversion.
- Standard Linux tools used by the transfer/cache path: `sh`, `stat`, `dd`, `base64`, `mkdir`, `mv`, `rm`, and `find`.

The local Herdr App displays only cached page images; it does not need to mount the remote filesystem. There is no automatic fallback that downloads the original document when a remote renderer is missing.

## Install

Copy the mod into Herdr's home:

```sh
cp -R mods/document-reader ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/document-reader
```

The manifest is `"place": "none"`: installing does not add a permanent sidebar or change your layout.

### Open a local document

```sh
herdr-app do tab.new \
  --name 'Document' \
  --mod document-reader \
  --props '{"file":"/absolute/path/to/document.pdf"}'
```

Or open it beside the current pane:

```sh
herdr-app do pane.split \
  --direction right \
  --mod document-reader \
  --props '{"file":"/absolute/path/to/presentation.pptx"}'
```

### Open a remote document

Use a machine name from `hc machine ls` as `props.on`:

```sh
herdr-app do tab.new \
  --name 'Remote document' \
  --mod document-reader \
  --props '{"file":"/srv/docs/paper.pdf","on":"vps"}'
```

Remote rendering runs `stat`, `pdfinfo`, `pdftoppm`, `pdftotext`, and (for Office) `soffice` with Herdr's `exec(..., { on })`. Only the current and nearby rendered pages are downloaded.

Supported extensions:

- PDF: `.pdf`
- Word: `.doc`, `.docx`, `.odt`, `.rtf`
- Excel: `.xls`, `.xlsx`, `.ods`
- PowerPoint: `.ppt`, `.pptx`, `.odp`

## Remote rendering and refresh

- Remote cache key: machine + source path + high-resolution mtime + size.
- Remote page quality: 1400px normally, 3600px above 175% zoom. Local quality remains 1800/3600px.
- PNG downloads use 2 MiB binary chunks encoded with Base64. A lookup-table decoder avoids the CPU cost of repeated string searches, and every chunk's decoded length is checked.
- Local images are written under `~/.config/herdr-app/data/document-reader/`; remote renders and Office PDFs use `~/.cache/herdr-document-reader/` on the source machine.
- A two-second remote metadata poll reloads changed documents. Local files additionally use `watchFolder()`.
- Remote external-open is disabled because it would otherwise open the wrong local path. The footer shows the source machine.
- If conversion, rendering, or the connection fails during reload, the previous document stays visible and the error appears in the footer.

## Herdr key integration

The reader's unmodified and navigation keys work when its pane has focus. To add the two Herdr-level commands, merge this section into `keys.json` without replacing existing sections:

```json
"mod:document-reader": {
  "ctrl-shift-f": "document-reader.search",
  "ctrl-shift-r": "document-reader.reload"
}
```

Other Herdr shortcuts continue to work, including the command palette, pane navigation, tab management, and application zoom.

### Reader keys

| Key | Action |
|---|---|
| `j` / `k`, arrows, `J` / `K` | Next / previous page |
| `Ctrl-d` / `Ctrl-u` | Half-screen down / up |
| `Ctrl-f` / `Ctrl-b` | Page down / up |
| `gg`, `G`, `12G` | First page, last page, page 12 |
| `h` / `l` | Pan a zoomed page |
| `+` / `-` | Zoom in / out |
| `0` / `a`, `s` | Fit page, fit width |
| `c` | Toggle single-page / continuous mode |
| `/`, `n`, `N` | Search, next match, previous match |
| `r` / `R` | Reload the latest source file |
| `o` | Open a local document externally |
| `q` | Close the reader pane |
| `?` | Open the key and mouse help |

### Mouse

- Wheel: turn pages in single-page mode; scroll in continuous mode.
- Ctrl+wheel: zoom around the pointer in single-page mode.
- Drag: pan an enlarged page.
- Double-click: toggle fit-page and 200% zoom at the pointer.
- Every toolbar action also works without the keyboard.

## Open from a file tree

A file panel can open a local or remote document with:

```js
run("tab.new", {
  name: basename(path),
  space,
  mod: "document-reader",
  props: { file: path, on: machine ?? null },
});
```

Herdr's shipped Files panel and layouts are read-only: clone them before changing their click handling. A `herdr-nvim` file tree can route `.pdf` and the Office extensions above to the same command.

## Mod commands

Shown reader copies accept commands through Herdr's `<mod>.<command>` mechanism:

```text
document-reader.next
document-reader.prev
document-reader.zoom-in
document-reader.zoom-out
document-reader.fit
document-reader.fit-width
document-reader.continuous
document-reader.reload
document-reader.search
document-reader.search:Fe
document-reader.search-next
document-reader.search-prev
document-reader.help
document-reader.open
```

`document-reader.search:Fe` searches for `Fe`; URI-escaped queries are decoded too.

## Files and programs

The mod makes no network requests outside the existing herdr-core machine connection. It reads selected local or remote documents and writes only the two cache locations described above.

- PDF rendering: `pdfinfo`, `pdftoppm`, `pdftotext`.
- Office conversion: LibreOffice through `soffice`, with an isolated profile and `TMPDIR` inside the conversion work directory.
- Cache and metadata: `stat`, `mv`, `rm`, `mkdir`, `find`, and `pwd` through Herdr's `exec` API.
- Page transfer: `dd` and `base64` on the source machine.
- External opening for local documents: `zathura` or `libreoffice`.

Cached pages are keyed by machine, source path, modification time, size, page, and render quality. Conversion and page writes use temporary files followed by atomic renames. Inactive local entries are pruned after 14 days or above 60 document versions; remote cache directories older than 14 days are pruned too.

## Current limits

- Remote rendering is tested on Linux through a real herdr-core `--on` connection. Other remote platforms need their own verification.
- Password-protected PDFs are not supported yet.
- Office documents are static PDF previews, not editable documents or native spreadsheets.
- Excel pagination follows the workbook's print settings.
- Search jumps to matching pages but does not highlight text in the raster.
- PDF links, forms, annotations, animations, and SyncTeX are not implemented.
- Remote external-open and automatic original-document download fallback are not implemented.
- Physical mouse/keyboard input was not automated under Wayland; real-window rendering and Herdr mod commands were exercised instead.

See [RECIPE.md](RECIPE.md) for the implementation brief, compatibility notes, and verification checklist.
