export type AnnotationTarget = {
  /** CSS selector that re-finds this element from `document`. */
  selector: string;
  /** Best-effort React component chain, innermost first. Null outside React. */
  component: string | null;
  tag: string;
  /** First 120 characters of the element's visible text. */
  text: string;
  /** Viewport-relative box at the moment the note was written. */
  rect: { x: number; y: number; width: number; height: number };
};

export type Annotation = {
  id: string;
  note: string;
  status: "open" | "resolved";
  createdAt: string;
  /** Path, query, and hash of the page the note was written on. */
  url: string;
  viewport: { width: number; height: number };
  target: AnnotationTarget;
};

/** Where the notes are being kept: the dev server's file, or this browser. */
export type AnnotationSource = "file" | "browser";
