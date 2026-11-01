# GloryCast Retouch

AI + manual photo editor for church photographers (Windows and Mac).

**Layout:** presets and history on the left, photo with Before | After slider in the middle,
filmstrip at the bottom, tools on the right (AI Retouch, Adjust, Crop & Logo).

**AI Retouch** (measured on each photo on its own): fix colour cast from white garments,
fix white brightness, save burnt whites, iron clothes, brighten faces, smooth skin, remove blemishes.

**Adjust** (by hand): temperature, tint, exposure, contrast, highlights, shadows, whites, blacks,
vibrance, saturation, sharpen.

**Workflow:** every photo keeps its own edit. Edit one, then *Sync to selected* / *Sync to all*,
or *Copy edit* and *Paste*. Presets (built-in and your own, *+ Save*) apply to the photo and any selected ones.
History with undo/redo. Pick (P) / Reject (X), filter the filmstrip, zoom to 100% (Z or double-click).
Edits are remembered per file, so closing the app keeps your work.
Export all except rejected, picked only, or selected, as `name-GC.jpg`. Originals are never changed.

Keys: arrows move, P pick, X reject, U unflag, B before/after, Z zoom, Ctrl+Z / Ctrl+Shift+Z,
Ctrl+C / Ctrl+V edits, Ctrl+A select all. Double-click a slider to reset it.

Everything runs on the computer. No internet, no cost per photo.

## Build

`npm install`, `npm start`, `npm test`. The workflow `.github/workflows/retouch.yml` builds the
Windows installer and Mac apps, opens the packaged app to add, preview and export sample photos,
and only then puts the builds on branches `retouch-windows` and `retouch-mac`.
