import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createApiApp } from './server/app';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = createApiApp();

  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (isProduction) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    viteServer = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`MailPulse Warm-up Console running on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    httpServer.close(async () => {
      try {
        await viteServer?.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
