// Copy the repository's docs/ into the site as Starlight pages.
//
// docs/*.md stay the source of truth and keep reading well on GitHub, which renders frontmatter as
// a table at the top of the file. So the frontmatter Starlight needs is added here instead: the
// title from the page's H1 (removed from the body, since Starlight renders the title itself), a
// description from its first paragraph, and an editUrl pointing at the real file. Links are
// rewritten for the site: a sibling page becomes its route, anything else in the repository
// becomes its GitHub URL.
//
// The output under src/content/docs/docs/ is generated and gitignored. Runs before dev and build.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/zanaat-dev/baron';
// Not user documentation: the script for recording the demo GIF.
const SKIP = new Set(['demo.md']);

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const docsDir = join(siteRoot, '..', 'docs');
const outDir = join(siteRoot, 'src', 'content', 'docs', 'docs');

const pages = readdirSync(docsDir).filter((f) => f.endsWith('.md') && !SKIP.has(f));
const slugs = new Set(pages.map((f) => f.replace(/\.md$/, '')));

function rewriteLink(target) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path, anchor] = target.split('#');
  const hash = anchor === undefined ? '' : `#${anchor}`;
  const repoPath = posix.normalize(posix.join('docs', path));
  const sibling = repoPath.match(/^docs\/([^/]+)\.md$/);
  if (sibling !== null && slugs.has(sibling[1])) return `/docs/${sibling[1]}/${hash}`;
  return `${REPO}/blob/main/${repoPath}${hash}`;
}

/** Strip Markdown to plain text for a meta description. */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function describe(body) {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !/^([#>|`-]|\d+\.|!\[)/.test(p));
  if (paragraph === undefined) return undefined;
  const text = plain(paragraph);
  if (text.length <= 200) return text;
  return `${text.slice(0, 197).replace(/\s+\S*$/, '')}…`;
}

const yamlString = (s) => JSON.stringify(s);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of pages) {
  const source = readFileSync(join(docsDir, file), 'utf8').replace(/\r\n/g, '\n');
  const h1 = source.match(/^# (.+)\n/);
  if (h1 === null) {
    console.error(`sync-docs: ${file} has no leading "# Title" line`);
    process.exit(1);
  }
  const title = plain(h1[1]);
  const body = source
    .slice(h1[0].length)
    // Links and images, but not inside fenced code: split on fences and touch only prose.
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : chunk.replace(/(\]\()([^)\s]+)(\))/g, (_, a, t, b) => a + rewriteLink(t) + b),
    )
    .join('');
  const description = describe(body);
  const frontmatter = [
    '---',
    `title: ${yamlString(title)}`,
    ...(description !== undefined ? [`description: ${yamlString(description)}`] : []),
    `editUrl: ${yamlString(`${REPO}/edit/main/docs/${file}`)}`,
    '---',
    '',
  ].join('\n');
  writeFileSync(join(outDir, file), frontmatter + body.replace(/^\n+/, ''));
}

// The demo recording is shown on the landing page.
const publicDemo = join(siteRoot, 'public', 'demo');
mkdirSync(publicDemo, { recursive: true });
copyFileSync(join(docsDir, 'demo', 'baron-demo.gif'), join(publicDemo, 'baron-demo.gif'));

console.log(`sync-docs: ${pages.length} page(s) from docs/ -> src/content/docs/docs/`);
