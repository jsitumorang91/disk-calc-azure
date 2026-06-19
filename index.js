const { CosmosClient } = require('@azure/cosmos');

// ===== Configuration =====
// All come from SWA application settings (see README phase 4).
const DATABASE  = process.env.COSMOS_DATABASE  || 'bbb-tools';
const CONTAINER = process.env.COSMOS_CONTAINER || 'saved-scenarios';

// Lazy-init the Cosmos client/container so a misconfiguration surfaces in the
// request response rather than crashing the worker on cold start.
let _container;
function getContainer() {
  if (_container) return _container;
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key      = process.env.COSMOS_KEY;
  if (!endpoint || !key) {
    throw new Error('Missing COSMOS_ENDPOINT or COSMOS_KEY in app settings.');
  }
  const client = new CosmosClient({ endpoint, key });
  _container = client.database(DATABASE).container(CONTAINER);
  return _container;
}

// ===== Helpers =====
function getPrincipal(req) {
  // SWA injects this header for every authenticated request.
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function bad(status, msg)   { return { status, body: { error: msg } }; }
function ok (status, body)  { return { status, body }; }

// ===== Handler =====
module.exports = async function (context, req) {
  // SWA enforces auth via staticwebapp.config.json routes, but we double-check
  // here because Functions can be hit directly during local dev.
  const principal = getPrincipal(req);
  if (!principal || !principal.userId) {
    context.res = bad(401, 'Not authenticated.');
    return;
  }
  const userId = principal.userId;
  const id = (req.params && req.params.id) || null;

  let container;
  try {
    container = getContainer();
  } catch (err) {
    context.log.error('Cosmos config error:', err.message);
    context.res = bad(500, err.message);
    return;
  }

  try {
    // ----- LIST -----
    if (req.method === 'GET' && !id) {
      const { resources } = await container.items
        .query({
          query: 'SELECT c.id, c.name, c.savedAt, c.data FROM c WHERE c.userId = @uid ORDER BY c.savedAt DESC',
          parameters: [{ name: '@uid', value: userId }]
        })
        .fetchAll();
      context.res = ok(200, resources);
      return;
    }

    // ----- GET ONE -----
    if (req.method === 'GET' && id) {
      try {
        const { resource } = await container.item(id, userId).read();
        if (!resource) { context.res = bad(404, 'Scenario not found.'); return; }
        context.res = ok(200, resource);
      } catch (e) {
        if (e.code === 404) { context.res = bad(404, 'Scenario not found.'); return; }
        throw e;
      }
      return;
    }

    // ----- CREATE -----
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = (body.name || '').toString().trim();
      if (!name) { context.res = bad(400, 'name is required.'); return; }
      const doc = {
        id: newId(),
        userId,
        name,
        data: body.data || {},
        savedAt: new Date().toISOString()
      };
      const { resource } = await container.items.create(doc);
      context.res = ok(201, resource);
      return;
    }

    // ----- UPDATE -----
    if (req.method === 'PUT') {
      if (!id) { context.res = bad(400, 'id parameter required.'); return; }
      const body = req.body || {};
      let existing;
      try {
        const result = await container.item(id, userId).read();
        existing = result.resource;
      } catch (e) {
        if (e.code === 404) { context.res = bad(404, 'Scenario not found.'); return; }
        throw e;
      }
      if (!existing) { context.res = bad(404, 'Scenario not found.'); return; }

      const updated = {
        ...existing,
        name:  body.name !== undefined ? String(body.name).trim() : existing.name,
        data:  body.data !== undefined ? body.data : existing.data,
        savedAt: new Date().toISOString()
      };
      const { resource } = await container.item(id, userId).replace(updated);
      context.res = ok(200, resource);
      return;
    }

    // ----- DELETE -----
    if (req.method === 'DELETE') {
      if (!id) { context.res = bad(400, 'id parameter required.'); return; }
      try {
        await container.item(id, userId).delete();
        context.res = { status: 204 };
      } catch (e) {
        if (e.code === 404) { context.res = bad(404, 'Scenario not found.'); return; }
        throw e;
      }
      return;
    }

    context.res = bad(405, `Method ${req.method} not allowed.`);
  } catch (err) {
    context.log.error('Unhandled API error:', err.message, err.stack);
    context.res = bad(500, err.message || 'Internal error.');
  }
};
