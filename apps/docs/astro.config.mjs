import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  site: 'https://chaitanyarahalkar.github.io',
  base: '/connect',
  integrations: [
    starlight({
      title: 'Connect',
      description: 'A credential broker for agents and services.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/chaitanyarahalkar/connect' },
      ],
      editLink: {
        baseUrl: 'https://github.com/chaitanyarahalkar/connect/edit/main/apps/docs/',
      },
      plugins: [
        starlightTypeDoc({
          entryPoints: ['../../packages/sdk/src/index.ts'],
          tsconfig: '../../packages/sdk/tsconfig.json',
          output: 'api',
          sidebar: { label: 'SDK API Reference', collapsed: false },
          typeDoc: {
            readme: 'none',
            excludeInternal: true,
            entryFileName: 'index',
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: ['getting-started', 'concepts'],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
