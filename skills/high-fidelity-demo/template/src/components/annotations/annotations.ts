import type { Annotation, AnnotationTarget } from "./types";

/**
 * The non-React half of the annotation widget: describing what the user
 * clicked, and moving the notes between the dev server's file and this browser.
 */

/** Every part of the widget carries this, so the picker can ignore its own DOM. */
export const ANNOTATION_UI_ATTR = "data-annotation-ui";

/** Set `data-demo-id="..."` on an element to give it a stable, readable selector. */
const STABLE_ID_ATTR = "data-demo-id";

const ENDPOINT = "/__annotations";
const BROWSER_KEY = "high-fidelity-demo:annotations";

export function isAnnotationUi(node: Element | null): boolean {
  return Boolean(node?.closest(`[${ANNOTATION_UI_ATTR}]`));
}

/** The topmost element under the pointer that is not part of the widget. */
export function elementAt(x: number, y: number): Element | null {
  const stack = document.elementsFromPoint(x, y);
  return stack.find((node) => !isAnnotationUi(node)) ?? null;
}

export function cssPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node && node !== document.documentElement) {
    const stable = node.getAttribute(STABLE_ID_ATTR);
    if (stable) {
      parts.unshift(`[${STABLE_ID_ATTR}="${stable}"]`);
      break;
    }
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    let step = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node?.tagName);
      if (sameTag.length > 1) step += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(step);
    node = parent;
  }

  return parts.join(" > ") || "body";
}

function visibleText(element: Element): string {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Best effort: walk React's fiber chain for the components wrapping this element. */
function reactChain(element: Element): string | null {
  try {
    const key = Object.keys(element).find(
      (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
    );
    if (!key) return null;

    let fiber = (element as unknown as Record<string, unknown>)[key] as
      | { type?: unknown; return?: unknown }
      | undefined;
    const names: string[] = [];

    while (fiber && names.length < 4) {
      const type = fiber.type as any;
      const name: string | null =
        typeof type === "function"
          ? (type.displayName ?? type.name ?? null)
          : type && typeof type === "object"
            ? (type.displayName ?? null)
            : null;
      if (name && name !== "Anonymous" && !names.includes(name)) names.push(name);
      fiber = fiber.return as typeof fiber;
    }

    return names.length ? names.join(" < ") : null;
  } catch {
    return null;
  }
}

export function describeTarget(element: Element): AnnotationTarget {
  const rect = element.getBoundingClientRect();
  return {
    selector: cssPath(element),
    component: reactChain(element),
    tag: element.tagName.toLowerCase(),
    text: visibleText(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

export function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function createAnnotation(note: string, target: AnnotationTarget): Annotation {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    note: note.trim(),
    status: "open",
    createdAt: new Date().toISOString(),
    url: currentUrl(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    target,
  };
}

/** The notes as Markdown, for pasting into chat when the file cannot be read. */
export function annotationsToMarkdown(list: Annotation[]): string {
  const open = list.filter((note) => note.status === "open").length;
  const lines = [
    `# Demo annotations (${open} open, ${list.length - open} resolved)`,
    "",
    "Source of truth: `annotations.json` in the demo root.",
  ];

  list.forEach((note, index) => {
    lines.push(
      "",
      `## ${index + 1}. ${note.status} — ${note.target.component ?? note.target.tag}`,
      `- url: \`${note.url}\``,
      `- element: \`<${note.target.tag}>\` ${note.target.text ? `“${note.target.text}”` : ""}`.trimEnd(),
      `- selector: \`${note.target.selector}\``,
      `- written: ${note.createdAt}`,
      "",
      note.note,
    );
  });

  return `${lines.join("\n")}\n`;
}

export async function fileAnnotations(): Promise<Annotation[]> {
  const response = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`annotations endpoint returned ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("annotations endpoint did not return a list");
  return body as Annotation[];
}

export async function saveToFile(list: Annotation[]): Promise<void> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(list, null, 2),
  });
  if (!response.ok) throw new Error(`annotations endpoint returned ${response.status}`);
}

export function browserAnnotations(): Annotation[] {
  try {
    const raw = window.localStorage.getItem(BROWSER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}

export function saveToBrowser(list: Annotation[]): void {
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(list));
  } catch {
    // Blocked or full storage drops the browser copy. "Copy as Markdown" in the
    // panel is the way out.
  }
}
