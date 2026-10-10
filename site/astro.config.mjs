// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';

const REPO = 'https://github.com/zanaat-dev/baron';

export default defineConfig({
  site: 'https://baron.zanaat.dev',
  // The docs carry no raster images that need resizing, and sharp is a native dependency this
  // monorepo would otherwise have to install and approve for nothing.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Baron',
      description:
        'One contract for issues, branches, pull requests, CI and deployments, so a coding agent can write to any work tracker.',
      logo: { src: './src/assets/mark.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // docs/ at the repository root is the source; the site copy is generated (scripts/sync-docs.mjs).
      editLink: { baseUrl: `${REPO}/edit/main/` },
      lastUpdated: false,
      customCss: [
        '@fontsource-variable/bricolage-grotesque',
        '@fontsource/ibm-plex-sans/400.css',
        '@fontsource/ibm-plex-sans/600.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/theme.css',
      ],
      components: { Footer: './src/components/Footer.astro' },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      plugins: [
        starlightLlmsTxt({
          projectName: 'Baron',
          description:
            'Baron is an open-source work-orchestration layer for AI coding agents: issues, branches, pull requests, CI runs and deployments behind one normalized contract, across Azure DevOps, GitHub, Jira, Linear and Slack.',
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Getting started', slug: 'docs/getting-started' },
            { label: 'Concepts', slug: 'docs/concepts' },
            { label: 'Trying it with Claude Code', slug: 'docs/trying-with-claude-code' },
          ],
        },
        {
          label: 'Set up a provider',
          items: [
            { label: 'Azure DevOps', slug: 'docs/setup-azure-devops' },
            { label: 'Jira Cloud', slug: 'docs/setup-jira' },
            { label: 'Linear', slug: 'docs/setup-linear' },
            { label: 'Supported providers', slug: 'docs/providers' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'docs/configuration' },
            { label: 'Recipes', slug: 'docs/recipes' },
            { label: 'CLI', slug: 'docs/cli' },
            { label: 'MCP server & plugin', slug: 'docs/mcp' },
          ],
        },
      ],
    }),
  ],
});
