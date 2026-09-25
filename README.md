# Pencil Notes

A simple handwriting notebook for iPad and Apple Pencil that runs in the browser.
You write on real pages (Letter or A4), and **Export PDF** turns each page into one PDF
page exactly as it looks on screen. Nothing gets split across pages, because a stroke
belongs to the page you started it on and is cut off at that page's edge while you write.

No text recognition and no accounts. Notes are stored on the device.

## Using it

- **Pencil writes, fingers scroll.** Turn on the hand button to draw with a finger too.
- **Tools:** pen (5 colors, 3 sizes, pressure-sensitive), highlighter, and an eraser
  that removes whole strokes. Undo and redo are in the toolbar (or Cmd+Z / Shift+Cmd+Z).
- **Pages:** the buttons at the end of a note add a Blank, Lined or Grid page. Under each
  page you can change its style, insert a page below it, or delete it.
- **Zoom:** pinch, or use the − / + buttons. Tap the percentage to go back to 100%.
- **Notes list:** the sidebar button (top left) shows all notes, with New note and delete.
- **Export PDF:** creates a vector PDF, then offers Share / Save to Files or Download.

## Keep your notes safe

Notes live in the browser's storage on that device. Safari may clear storage for
websites you haven't opened in a while, so:

1. **Add it to the Home Screen** (Share button → Add to Home Screen). Home Screen apps
   keep their storage, open full screen, and work offline.
2. Now and then, use **Back up all notes** in the sidebar and keep the file in iCloud
   Drive. **Restore** loads it back.

## Hosting on GitHub Pages

It's plain HTML, CSS and JavaScript with no build step.
Repo Settings → Pages → Source: *Deploy from a branch* → `main`, folder `/ (root)`.
The site then appears at `https://<user>.github.io/<repo>/`.

To try it locally: `python3 -m http.server 8765`, then open http://localhost:8765.

## How it stays fast

- Each page has its own canvas, and only pages near the screen have one. A long note
  uses about as much memory as a short one.
- While you write, only the newest bit of the stroke is drawn. Nothing already on the
  page is redrawn.
- Each page is saved separately, so saving after a stroke writes that one page, not the
  whole note.
