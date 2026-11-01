# GloryCast Retouch

Batch photo fixing for church photographers (Windows and Mac).

Drop in a whole service. Each photo is checked on its own, then fixed with one set of sliders:

- **Fix colour cast**: uses the white garments as a reference to remove green, yellow or pink light.
- **Fix white brightness** and **Save burnt whites**: clean, bright white cloth that keeps its folds.
- **Brighten faces**: lifts faces that go dark next to white cloth.
- **Smooth skin**: evens skin, keeps eyes, lips and texture.
- **Iron clothes**: softens creases on white cloth, keeps pleats and seams.
- **Warm / cool**, **Colour strength**, **Overall brightness**.
- Looks: GloryCast Auto, Clean & cool, Outdoor, Indoor tube lights, Night / stage, Gentle.
- Shapes: original, IG post 4:5, square, story 9:16, YouTube 16:9, flyer A4.
- Logo watermark (position, size, see-through), export size and JPEG quality.

Every slider at 0 leaves the photo untouched. Double-click a slider to reset it.
Exports go to a folder you choose as `name-GC.jpg`; originals are never changed.

Everything runs on the computer. No internet, no cost per photo.

## Build

`npm install`, `npm start` to run, `npm test` for engine checks.
The workflow `.github/workflows/retouch.yml` builds the Windows installer and the Mac app
(Intel and Apple silicon) and puts them on branches `retouch-windows` and `retouch-mac`.

The Mac app is not signed yet: first time, right-click the app and choose Open.
