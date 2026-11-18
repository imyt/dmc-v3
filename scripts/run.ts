// Entry point for the long-running processes: `node dist/dmc.mjs <api|worker|migrate>` (built by `pnpm run build`), or `vite-node scripts/run.ts <api|worker|migrate>` in development.
const which = process.argv[2];
if (which === 'api') await (await import('../apps/api/src/main')).main();
else if (which === 'worker' || which === 'migrate') await (await import('../apps/worker/src/main')).main(which === 'migrate' ? ['migrate'] : []);
else { console.error('usage: run.ts <api|worker|migrate>'); process.exit(2); }
