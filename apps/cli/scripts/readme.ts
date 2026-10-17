/**
 * The repository's README as the published package carries it, with every relative link made
 * absolute.
 *
 * npm resolves a README's relative links against `repository.url` plus `repository.directory`
 * (`apps/cli`), but the README is the repository root's, so its relative links would point under
 * `apps/cli/` and break. Each becomes a GitHub URL at `ref`, the release's tag: images (and
 * `srcset`s) on raw.githubusercontent.com, which serves the file itself, and every other link on
 * github.com. A `srcset` is taken as one URL, as the README writes it.
 */

const REPOSITORY = "Ze-Norm/ZeNorm";

const IMAGE = /\.(?:png|gif|jpe?g|svg|webp)$/i;

/** Markdown link and image targets: `](target)`. */
const MARKDOWN_TARGET = /\]\(([^)\s]+)\)/g;

/** HTML attribute targets: `src="target"`, `srcset="target"`, `href="target"`. */
const HTML_TARGET = /\b(src|srcset|href)="([^"]+)"/g;

/** A target with a scheme (`https:`, `mailto:`), a fragment alone, or a site-absolute path. */
function isAbsolute(target: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/");
}

function absoluteUrl(target: string, ref: string): string {
  if (isAbsolute(target)) {
    return target;
  }
  const path = target.replace(/^\.\//, "");
  return IMAGE.test(path.replace(/#.*$/, ""))
    ? `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${path}`
    : `https://github.com/${REPOSITORY}/blob/${ref}/${path}`;
}

export function publishedReadme(readme: string, ref: string): string {
  return readme
    .replace(MARKDOWN_TARGET, (_, target: string) => `](${absoluteUrl(target, ref)})`)
    .replace(
      HTML_TARGET,
      (_, attribute: string, target: string) => `${attribute}="${absoluteUrl(target, ref)}"`,
    );
}
