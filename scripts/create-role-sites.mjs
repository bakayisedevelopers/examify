import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildStructuredData, getRouteSeo, PORTAL_SEO } from '../src/config/seo.js';
import { getPortalSiteUrl } from '../src/utils/portal.js';

const rootDirectory = process.cwd();
const buildDirectory = resolve(rootDirectory, 'dist');
const hostingDirectory = resolve(rootDirectory, 'dist-sites');
const portals = ['student', 'tutor', 'teacher', 'parent', 'admin'];

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const makeSitemap = (portal) => {
  const origin = getPortalSiteUrl(portal).replace(/\/$/, '');
  const routes = portal === 'admin' ? ['/policies'] : ['/', '/policies'];
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = routes.map((route) => `  <url>\n    <loc>${origin}${route === '/' ? '/' : route}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
};

for (const portal of portals) {
  const siteDirectory = resolve(hostingDirectory, portal);
  const origin = getPortalSiteUrl(portal).replace(/\/$/, '');
  const landingSeo = getRouteSeo('/', portal);

  await rm(siteDirectory, { recursive: true, force: true });
  await mkdir(siteDirectory, { recursive: true });
  await cp(buildDirectory, siteDirectory, { recursive: true });

  let html = await readFile(resolve(siteDirectory, 'index.html'), 'utf8');
  html = html
    .replaceAll('__SEO_TITLE__', escapeHtml(landingSeo.title))
    .replaceAll('__SEO_DESCRIPTION__', escapeHtml(landingSeo.description))
    .replaceAll('__SEO_KEYWORDS__', escapeHtml(PORTAL_SEO[portal].keywords))
    .replaceAll('__SEO_URL__', escapeHtml(landingSeo.url))
    .replaceAll('__SEO_ORIGIN__', escapeHtml(origin))
    .replaceAll('__SEO_ROBOTS__', escapeHtml(landingSeo.robots))
    .replace('__SEO_STRUCTURED_DATA__', JSON.stringify(buildStructuredData(portal, '/')).replaceAll('<', '\\u003c'));

  await writeFile(resolve(siteDirectory, 'index.html'), html);
  await writeFile(resolve(siteDirectory, 'sitemap.xml'), makeSitemap(portal));
  await writeFile(resolve(siteDirectory, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
}

console.log(`Generated role-specific Firebase Hosting builds in ${hostingDirectory}`);
