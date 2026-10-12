"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/**
 * A deck, read the way a deck is read: one page at a time, going right.
 *
 * The browser's own PDF viewer was doing this before and it is built for a
 * document rather than a presentation. It scrolls, so a fifteen slide deck in a
 * short frame becomes a thin column somebody drags through, and half of every
 * slide is cut off at any moment. It also brings its own toolbar, its own
 * scrollbar and its own idea of what the page is worth zooming to, none of
 * which can be styled and all of which can be turned off in Chrome and not in
 * Firefox.
 *
 * So the pages are drawn here, onto a canvas, and the frame is ours. Forward
 * and back are two buttons, the arrow keys and the scroll wheel; the wheel
 * works because the page is a canvas in this document rather than a viewer in
 * somebody else's, which is the whole reason for the change.
 *
 * pdf.js is loaded on demand and only once a deck is on the page. It is the
 * largest thing this product would ship and most readers never open a project.
 */

export function DeckViewer({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);

  /* The loaded document, kept outside React's state. It is a handle with a
     worker behind it, not a value to render, and putting it in state makes
     every page turn a reason to reconsider it. */
  const document = useRef<PDFDocumentProxy | null>(null);

  /* Which render is current. A page turn during a render would otherwise let
     the slower of the two finish last and paint the page nobody asked for. */
  const generation = useRef(0);

  /* The render in flight, so it can be stopped rather than merely disowned.
     Ignoring its result is not enough: it is still drawing into the canvas, and
     two pages painted into one bitmap leave the earlier one showing through the
     white the later one never covered. */
  const drawing = useRef<RenderTask | null>(null);

  /* One turn per gesture. A trackpad flick arrives as thirty wheel events and
     without this a deck jumps from the first slide to the last. */
  const turning = useRef(false);

  /* The first page's proportions, which become the frame's. A fixed shape suits
     one deck and wastes half the panel on the other: 16:9 slides in a 4:3 box
     get grey bands, and an A4 paper in a 16:9 box shrinks to a column between
     two of them. Decks are drawn at one size throughout, so page one decides. */
  const [shape, setShape] = useState<number | null>(null);

  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);

  /** Draw one page at the size the frame is actually showing. */
  const draw = useCallback(async (which: number) => {
    const pdf = document.current;
    const target = canvas.current;
    const box = frame.current;

    if (pdf === null || target === null || box === null) {
      return;
    }

    const mine = (generation.current += 1);

    drawing.current?.cancel();
    drawing.current = null;

    let sheet;
    try {
      sheet = await pdf.getPage(which);
    } catch {
      if (mine === generation.current) setFailed(true);
      return;
    }

    if (mine !== generation.current) {
      return;
    }

    /* Fitted to whichever of the two edges runs out first, so a portrait paper
       and a widescreen slide both land whole inside the same frame. */
    const unscaled = sheet.getViewport({ scale: 1 });
    const scale = Math.min(box.clientWidth / unscaled.width, box.clientHeight / unscaled.height);

    /* Drawn at the screen's real pixel density and shown at CSS size. Rendering
       at CSS size on a retina display produces the soft, slightly wrong text
       that makes a PDF look like a screenshot of a PDF. */
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = sheet.getViewport({ scale: scale * ratio });
    const context = target.getContext("2d");

    if (context === null) {
      return;
    }

    target.width = Math.floor(viewport.width);
    target.height = Math.floor(viewport.height);
    target.style.width = `${Math.floor(viewport.width / ratio)}px`;
    target.style.height = `${Math.floor(viewport.height / ratio)}px`;

    /* Cleared by hand as well as by the resize above. Assigning the same width
       back is allowed to be a no-op, and a page that happens to match the last
       one then paints over whatever survived. */
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, target.width, target.height);

    /*
      A 2D context we opened, and `canvas` explicitly null.

      pdf.js takes either and they are not the same path. Handed a canvas it
      picks its own backend, which on this version means asking for a WebGPU
      adapter; where there is not one — a headless browser, an older machine,
      anything without the flag — the page comes back solid black with no error
      to catch. Handed both, it renders through the context without applying the
      viewport's flip, and a PDF whose origin is the bottom left arrives upside
      down and mirrored. The types recommend `canvas`; both of those are what
      taking that advice looked like.
    */
    const task = sheet.render({
      canvasContext: context,
      canvas: null,
      viewport,
      background: "#ffffff",
    });

    drawing.current = task;

    try {
      await task.promise;
    } catch (error) {
      if (mine === generation.current && !(error instanceof Error && error.name === "RenderingCancelledException")) {
        setFailed(true);
      }
    } finally {
      if (drawing.current === task) {
        drawing.current = null;
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let loading: PDFDocumentLoadingTask | null = null;
    setPages(0);
    setPage(1);
    setShape(null);
    setFailed(false);

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        if (!alive) return;

        /* The worker is built from the package rather than fetched from a CDN.
           Nothing in this product loads code from a third party, and a viewer
           that did would be the one exception on every page it appeared. */
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();

        /* Only the bytes of the pages actually drawn. Left to its defaults
           pdf.js streams the whole file in the background, and the viewer opens
           with the project page, so every visit pulled up to twenty megabytes
           out of storage for a reader who looked at the first slide. A server
           that refuses ranges still gets the whole file, as before. */
        loading = pdfjs.getDocument({ url, disableAutoFetch: true, disableStream: true });
        const loaded = await loading.promise;

        if (!alive) {
          return;
        }

        document.current = loaded;
        setPages(loaded.numPages);

        const first = await loaded.getPage(1);
        if (!alive) return;
        const size = first.getViewport({ scale: 1 });

        /* Clamped, because a frame is not obliged to honour a poster or a
           spreadsheet exported sideways. */
        setShape(Math.min(Math.max(size.width / size.height, 0.6), 2.4));

        await draw(1);
      } catch {
        if (alive) {
          setFailed(true);
        }
      }
    })();

    return () => {
      alive = false;
      generation.current += 1;
      drawing.current?.cancel();
      drawing.current = null;
      document.current = null;
      // pdf.js owns the worker and pending requests on the loading task.
      // Destroy it even if navigation happens before the document is ready.
      void loading?.destroy().catch(() => {});
    };
  }, [url, draw]);

  const go = useCallback(
    (to: number) => {
      setPage((was) => {
        const next = Math.min(Math.max(to, 1), pages === 0 ? 1 : pages);

        if (next !== was) {
          void draw(next);
        }

        return next;
      });
    },
    [draw, pages],
  );

  /* Redrawn when the frame changes size, because the canvas was rasterised for
     the old width and a resized one is a stretched bitmap. */
  useEffect(() => {
    const box = frame.current;

    if (box === null || pages === 0) {
      return;
    }

    const watch = new ResizeObserver(() => void draw(page));
    watch.observe(box);

    return () => watch.disconnect();
  }, [draw, page, pages]);

  return (
    <div className="mt-6">
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label="Pitch deck"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "PageDown") {
            event.preventDefault();
            go(page + 1);
          }

          if (event.key === "ArrowLeft" || event.key === "PageUp") {
            event.preventDefault();
            go(page - 1);
          }
        }}
        /* Vertical wheel turns pages instead of scrolling. A deck has no down:
           the reader's gesture is "next", and their trackpad only knows how to
           say it one way. Horizontal wheel is honoured too, for the trackpads
           that do. */
        onWheel={(event) => {
          const push = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;

          if (Math.abs(push) < 12 || turning.current) {
            return;
          }

          turning.current = true;
          window.setTimeout(() => {
            turning.current = false;
          }, 260);

          go(page + (push > 0 ? 1 : -1));
        }}
        style={{ aspectRatio: shape ?? 16 / 9 }}
        className="relative grid max-h-[80vh] w-full place-items-center overflow-hidden rounded-[0.75rem] bg-paper-sunk ring-1 ring-inset ring-rule outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        {failed ? (
          <p className="px-6 text-center text-[0.9375rem] text-ink-soft">
            This deck could not be opened here. The download beside the title
            still has the file.
          </p>
        ) : (
          <canvas ref={canvas} className="max-h-full max-w-full" />
        )}

        {/* Over the page rather than under it, so the frame stays the size it
            was measured at. Controls in a row below would shrink the page every
            time the deck loaded. */}
        {pages > 1 && (
          <>
            <Arrow
              side="left"
              disabled={page <= 1}
              onClick={() => go(page - 1)}
            />

            <Arrow
              side="right"
              disabled={page >= pages}
              onClick={() => go(page + 1)}
            />

            <p className="tabular absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-[0.8125rem] text-paper">
              {page} / {pages}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Arrow({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? "Previous page" : "Next page"}
      className={`absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-paper/90 text-ink ring-1 ring-inset ring-rule backdrop-blur transition-opacity duration-150 ease-settle hover:bg-paper disabled:pointer-events-none disabled:opacity-0 ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 ${side === "left" ? "" : "rotate-180"}`}
      >
        <path d="M10 3 5 8l5 5" />
      </svg>
    </button>
  );
}
