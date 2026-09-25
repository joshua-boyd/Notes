# Pencil Notes

A simple handwriting notebook for iPad and Apple Pencil that runs in the browser.
You write on real pages, and **Export PDF** turns each page into one PDF page exactly
as it looks on screen. Nothing gets split across pages, because a stroke belongs to the
page you started it on and is cut off at that page's edge while you write.

No text recognition and no accounts.

## Using it

- **Pencil writes, fingers scroll.** Turn on the hand button to draw with a finger too.
- **Tools:** pen (5 colors, 3 sizes, pressure-sensitive), highlighter, and an eraser
  that removes whole strokes. Undo and redo are in the toolbar (or Cmd+Z / Shift+Cmd+Z).
- **Pages:** the buttons at the end of a note add a Blank, Lined or Grid page. Under each
  page you can change its style, insert a page below it, or delete it.
- **Organize pages** (the four-squares button): thumbnails of every page. Drag a page to
  move it (with a finger, press and hold first; with the Pencil, just drag). Or tap a
  page to select it and use Move earlier / Move later / Duplicate / Delete. Tap a
  selected page again to jump to it. Everything can be undone.
- **Import PDF** (the page-with-plus button): opens a PDF as a new note, or adds its
  pages to the end of the current note. Write on the pages, and insert blank, lined or
  grid pages anywhere in between. Blank pages use the Letter/A4 setting; PDF pages keep
  their own size.
- **Zoom:** pinch, or use the − / + buttons. Tap the percentage to go back to 100%.
- **Notes list:** the sidebar button (top left) shows all notes, with New note and delete.
- **Export PDF:** creates a PDF, then offers Share / Save to Files or Download. Pages that
  came from an imported PDF are copied from the original, so their text stays sharp and
  selectable; your writing is added on top as vector lines.

## Where notes are stored

Notes are stored **in the browser on the device you write on** (IndexedDB), not in this
repo and not on any server. The repo only holds the app's code. Notes don't sync
between devices on their own.

Safari may clear storage for websites you haven't opened in a while, so:

1. **Add it to the Home Screen** (Share button → Add to Home Screen). Home Screen apps
   keep their storage, open full screen, and work offline.
2. Now and then, use **Back up all notes** in the sidebar and keep the file in iCloud
   Drive. The backup includes imported PDFs. **Restore** loads it back, on this or
   another device.

## Hosting on GitHub Pages

It's plain HTML, CSS and JavaScript with no build step.
Repo Settings → Pages → Source: *Deploy from a branch* → `main`, folder `/ (root)`.
The site then appears at `https://<user>.github.io/<repo>/`.

To try it locally: `python3 -m http.server 8765`, then open http://localhost:8765.

## How it stays fast

- Each page has its own canvas, and only the pages near the screen have one (about 5 at
  a time). A 150-page note uses about as much memory as a 3-page one.
- While you write, only the newest bit of the stroke is drawn; nothing already on the
  page is redrawn, so the cost per Pencil sample doesn't grow with the note.
- An imported PDF page is drawn once into an image that is reused, so writing on a PDF
  page costs the same as writing on a blank one. The PDF engine is only loaded for
  notes that contain PDF pages.
- Each page is saved separately, so saving after a stroke writes that one page, not the
  whole note.

## Third-party code

`vendor/` contains unmodified copies of [pdf.js](https://github.com/mozilla/pdf.js)
6.3.289 (Apache-2.0), used to show imported PDFs, and
[pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT), used to write the exported
PDF. Their licenses are next to them.
