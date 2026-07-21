#!/usr/bin/env node
// One-shot, idempotent codemod to make the workspace packages publish-ready to npm best practices:
// adds repository/homepage/bugs/author/keywords/description, sets version 0.1.0, copies LICENSE into
// each package (npm auto-includes it in the tarball), and writes a concise per-package README. Safe to
// re-run. @lonca/baron-conformance is marked private (test-only; not published in v0.1.0 — see RELEASING.md).
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '0.20.0';
const REPO = 'https://github.com/loncadev/baron';
const BASE_KEYWORDS = ['baron', 'ai-agents', 'mcp', 'work-orchestration', 'devops'];

const META = {
  '@lonca/baron-core': {
    description:
      'Baron core: capability-port contracts, the semantic role layer, and adapter base classes.',
    keywords: ['ports', 'roles'],
  },
  '@lonca/baron-providers': {
    description:
      'Baron provider registry: builds the live ports a policy binds, plus the native escape hatch.',
    keywords: ['providers', 'policy'],
  },
  '@lonca/baron-recipes': {
    description:
      'Baron recipe engine: run declarative YAML workflows over Baron primitives, deterministically.',
    keywords: ['recipes', 'workflows', 'yaml'],
  },
  '@lonca/baron-cli': {
    description:
      'Baron CLI: introspect a provider, validate the policy, and run recipes (baron init / doctor / run).',
    keywords: ['cli'],
    bin: true,
  },
  '@lonca/baron-mcp-server': {
    description:
      'Baron MCP server: drive issues, scm, ci, deploy, and notify across providers from any MCP client.',
    keywords: ['mcp', 'model-context-protocol', 'claude', 'server'],
    bin: true,
  },
  '@lonca/baron-knowledge-loop': {
    description: 'Baron knowledge loop: durable learnings and follow-ups with a pluggable store.',
    keywords: ['knowledge', 'learnings'],
  },
  '@lonca/baron-conformance': {
    description: 'Baron adapter conformance suite and in-memory transports (test support).',
    keywords: ['conformance', 'testing'],
    private: true,
  },
  '@lonca/baron-adapter-azure-devops': {
    description: 'Baron adapter for Azure DevOps: issues, scm, ci, deploy.',
    keywords: ['azure-devops', 'adapter'],
  },
  '@lonca/baron-adapter-github': {
    description: 'Baron adapter for GitHub: issues, scm, ci, deploy.',
    keywords: ['github', 'adapter'],
  },
  '@lonca/baron-adapter-slack': {
    description: 'Baron adapter for Slack: notify.',
    keywords: ['slack', 'adapter', 'notify'],
  },
};

function findPackages(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findPackages(full, out);
    else if (entry === 'package.json') out.push(full);
  }
  return out;
}

function readme(name, meta, relDir) {
  const short = name.replace('@lonca/baron-', '');
  const install = meta.bin
    ? short === 'cli'
      ? '```bash\nnpm install -g @lonca/baron-cli   # then: baron --help\n```'
      : '```bash\nnpx -y @lonca/baron-mcp-server\n```'
    : `\`\`\`bash\nnpm install ${name}\n\`\`\``;
  return `# ${name}

${meta.description}

Part of **[Baron](${REPO})** — a platform-agnostic work-orchestration layer for AI coding agents:
one pane of glass (issues, scm, ci, deploy, notify) across providers, via MCP + CLI.

## Install

${install}

## Documentation

See the [Baron documentation](${REPO}#readme). Source: [\`${relDir}\`](${REPO}/tree/main/${relDir}).

## License

[Apache-2.0](./LICENSE) © Baron contributors.
`;
}

const licenseSrc = join(ROOT, 'LICENSE');
let changed = 0;

for (const pkgPath of findPackages(join(ROOT, 'packages'))) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const meta = META[pkg.name];
  if (!meta) continue;
  const dir = dirname(pkgPath);
  const relDir = relative(ROOT, dir).split('\\').join('/');

  pkg.version = VERSION;
  // Ship only build output — never src (which would drag *.test.ts + the vitest devDep into the
  // tarball). @lonca/baron-recipes additionally ships its packaged recipe YAML, read at runtime.
  pkg.files = pkg.name === '@lonca/baron-recipes' ? ['dist', 'recipes'] : ['dist'];
  pkg.description = meta.description;
  pkg.keywords = [...new Set([...BASE_KEYWORDS, ...(meta.keywords ?? [])])];
  pkg.author = 'Baron contributors';
  pkg.license = 'Apache-2.0';
  pkg.homepage = `${REPO}#readme`;
  pkg.bugs = { url: `${REPO}/issues` };
  pkg.repository = { type: 'git', url: `git+${REPO}.git`, directory: relDir };
  if (meta.private) pkg.private = true;

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(licenseSrc, join(dir, 'LICENSE'));
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) writeFileSync(readmePath, readme(pkg.name, meta, relDir));
  changed += 1;
  console.log(`prepped ${pkg.name}  (${relDir})${meta.private ? '  [private]' : ''}`);
}

console.log(`\nDone: ${changed} packages. Version set to ${VERSION}.`);
