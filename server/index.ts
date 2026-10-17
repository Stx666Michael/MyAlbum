import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApiApp } from './app.ts';

const PORT = Number(process.env.PORT || 3001);
const app = createApiApp();

const distPath = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(path.join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
}

app.listen(PORT, () => {
  console.log(`MyAlbum server listening at http://localhost:${PORT}`);
});
