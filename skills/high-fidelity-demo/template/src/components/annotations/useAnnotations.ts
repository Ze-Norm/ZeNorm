import * as React from "react";
import {
  browserAnnotations,
  createAnnotation,
  fileAnnotations,
  saveToBrowser,
  saveToFile,
} from "./annotations";
import type { Annotation, AnnotationSource, AnnotationTarget } from "./types";

/**
 * The notes, kept on the dev server's `annotations.json` when the template's
 * Vite plugin is running, and in this browser when it is not.
 */
export function useAnnotations() {
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  const [source, setSource] = React.useState<AnnotationSource>("file");
  const [ready, setReady] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setAnnotations(await fileAnnotations());
      setSource("file");
    } catch {
      setAnnotations(browserAnnotations());
      setSource("browser");
    } finally {
      setReady(true);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // The agent edits annotations.json between rounds, and the demo may be open
  // in more than one tab: re-read on focus and on a slow poll.
  React.useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const commit = React.useCallback(
    async (next: Annotation[]) => {
      setAnnotations(next);
      if (source === "file") {
        try {
          await saveToFile(next);
          return;
        } catch {
          setSource("browser");
        }
      }
      saveToBrowser(next);
    },
    [source],
  );

  const add = React.useCallback(
    async (note: string, target: AnnotationTarget) => {
      await commit([...annotations, createAnnotation(note, target)]);
    },
    [annotations, commit],
  );

  const update = React.useCallback(
    async (id: string, patch: Partial<Annotation>) => {
      await commit(annotations.map((note) => (note.id === id ? { ...note, ...patch } : note)));
    },
    [annotations, commit],
  );

  const remove = React.useCallback(
    async (id: string) => {
      await commit(annotations.filter((note) => note.id !== id));
    },
    [annotations, commit],
  );

  const clearResolved = React.useCallback(async () => {
    await commit(annotations.filter((note) => note.status === "open"));
  }, [annotations, commit]);

  const openCount = annotations.filter((note) => note.status === "open").length;

  return { annotations, openCount, source, ready, refresh, add, update, remove, clearResolved };
}

export type AnnotationStore = ReturnType<typeof useAnnotations>;
