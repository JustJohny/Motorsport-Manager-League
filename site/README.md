# MM League website

Vite + React + TypeScript + shadcn/ui. Hosted on GitHub Pages, with Supabase for data and Discord login.

```sh
npm install
npm run dev      # demo mode unless .env.local sets the Supabase URL and anon key
npm run build
```

- **Demo mode:** with no Supabase settings the site loads `public/demo-state.json` (gitignored) and shows you as organizer. Create it with
  `npx tsx ../src/cli.ts extract "<save>" --league ../examples/league.json -o public/demo-state.json`.
- **Data** comes from `mmsave publish` (see the root README). Shapes are in `../src/league-types.ts`, shared with the toolkit.
- **Routing** uses a hash router, because GitHub Pages has no SPA fallback.
- **UI components** live in `src/components/ui` (shadcn). Add more with `npx shadcn@latest add <name>`.
