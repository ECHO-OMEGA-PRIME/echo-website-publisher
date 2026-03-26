import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SITES: R2Bucket;
  DB: D1Database;
}

interface PublishRequest {
  siteId: string;
  title: string;
  description?: string;
  pages: { slug: string; html: string }[];
  customDomain?: string;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// CORS — allow echo-ept.com and localhost
app.use('*', cors({
  origin: ['https://echo-ept.com', 'https://www.echo-ept.com', 'http://localhost:3000', 'http://localhost:3001'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'echo-website-publisher',
    version: '1.0.0',
  });
});

// ---------------------------------------------------------------------------
// POST /publish — store site pages in R2, return live URL
// ---------------------------------------------------------------------------

app.post('/publish', async (c) => {
  const body = await c.req.json<PublishRequest>();

  if (!body.siteId || !body.pages || body.pages.length === 0) {
    return c.json({ error: 'siteId and pages are required' }, 400);
  }

  const env: Env = c.env;
  const siteId = body.siteId.replace(/[^a-zA-Z0-9_-]/g, '');

  // Store each page in R2 under sites/{siteId}/{path}
  for (const page of body.pages) {
    const key = page.slug === '/'
      ? `sites/${siteId}/index.html`
      : `sites/${siteId}/${page.slug.replace(/^\//, '')}/index.html`;

    await env.SITES.put(key, page.html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
      customMetadata: { title: body.title || '', siteId },
    });
  }

  // Store site manifest
  const manifest = {
    siteId,
    title: body.title,
    description: body.description || '',
    pages: body.pages.map(p => p.slug),
    customDomain: body.customDomain || null,
    publishedAt: new Date().toISOString(),
    pageCount: body.pages.length,
  };
  await env.SITES.put(`sites/${siteId}/manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Store metadata in D1
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO published_sites (site_id, title, description, custom_domain, page_count, published_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(siteId, body.title, body.description || '', body.customDomain || null, body.pages.length).run();
  } catch (err: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'D1 insert failed', error: err.message }));
    // Non-fatal — R2 storage is the source of truth
  }

  const siteUrl = `https://echo-website-publisher.bmcii1976.workers.dev/site/${siteId}`;

  return c.json({
    success: true,
    url: siteUrl,
    siteId,
    pages: body.pages.length,
  });
});

// ---------------------------------------------------------------------------
// GET /site/:siteId/manifest.json — site metadata (BEFORE wildcard)
// ---------------------------------------------------------------------------

app.get('/site/:siteId/manifest.json', async (c) => {
  const siteId = c.req.param('siteId').replace(/[^a-zA-Z0-9_-]/g, '');
  const object = await c.env.SITES.get(`sites/${siteId}/manifest.json`);
  if (!object) return c.json({ error: 'Site not found' }, 404);
  const manifest = await object.json();
  return c.json(manifest);
});

// ---------------------------------------------------------------------------
// GET /site/:siteId — serve the index page
// GET /site/:siteId/* — serve sub-pages
// ---------------------------------------------------------------------------

app.get('/site/:siteId', async (c) => {
  return serveSitePage(c, c.req.param('siteId'), '/');
});

app.get('/site/:siteId/*', async (c) => {
  const siteId = c.req.param('siteId');
  const path = c.req.path.replace(`/site/${siteId}`, '') || '/';
  return serveSitePage(c, siteId, path);
});

async function serveSitePage(c: any, siteId: string, path: string): Promise<Response> {
  const env: Env = c.env;
  const cleanSiteId = siteId.replace(/[^a-zA-Z0-9_-]/g, '');

  // Determine R2 key
  let key: string;
  if (path === '/' || path === '') {
    key = `sites/${cleanSiteId}/index.html`;
  } else {
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    // Try exact file first, then directory/index.html
    key = cleanPath.endsWith('.html')
      ? `sites/${cleanSiteId}/${cleanPath}`
      : `sites/${cleanSiteId}/${cleanPath}/index.html`;
  }

  const object = await env.SITES.get(key);
  if (!object) {
    // Fallback: try without /index.html suffix
    if (!key.endsWith('index.html')) {
      const fallback = await env.SITES.get(`sites/${cleanSiteId}/${path.replace(/^\//, '')}.html`);
      if (fallback) {
        return new Response(fallback.body, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
    }
    return c.html('<h1>Page not found</h1><p>This page does not exist on this site.</p>', 404);
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ---------------------------------------------------------------------------
// GET /sites — list all published sites
// ---------------------------------------------------------------------------

app.get('/sites', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT site_id, title, description, custom_domain, page_count, published_at FROM published_sites ORDER BY published_at DESC LIMIT 100'
    ).all();
    return c.json({ sites: result.results || [] });
  } catch {
    return c.json({ sites: [] });
  }
});

// ---------------------------------------------------------------------------
// DELETE /site/:siteId — remove a published site
// ---------------------------------------------------------------------------

app.delete('/site/:siteId', async (c) => {
  const siteId = c.req.param('siteId').replace(/[^a-zA-Z0-9_-]/g, '');
  const env: Env = c.env;

  // List and delete all R2 objects for this site
  const listed = await env.SITES.list({ prefix: `sites/${siteId}/` });
  for (const obj of listed.objects) {
    await env.SITES.delete(obj.key);
  }

  // Remove from D1
  try {
    await env.DB.prepare('DELETE FROM published_sites WHERE site_id = ?').bind(siteId).run();
  } catch {
    // Non-fatal
  }

  return c.json({ success: true, deleted: siteId });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

app.all('*', (c) => {
  return c.json({
    error: 'Not found',
    routes: [
      'GET /health',
      'POST /publish',
      'GET /site/:siteId',
      'GET /sites',
      'DELETE /site/:siteId',
    ],
  }, 404);
});

export default app;
