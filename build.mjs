import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['--check', 'assets/app.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', 'functions/api/[[route]].js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'tests/api.test.mjs'], { stdio: 'inherit' });
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'assets', '_headers']) await cp(file, 'dist/' + file, { recursive: true });
console.log('Dashboard static assets are ready in dist.');
