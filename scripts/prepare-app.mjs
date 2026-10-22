// Copies the three editor files into dist-app/ so the desktop app can bundle them.
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';

rmSync('dist-app', { recursive: true, force: true });
mkdirSync('dist-app', { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.js', 'logo.svg']) copyFileSync(f, 'dist-app/' + f);
console.log('dist-app ready');
