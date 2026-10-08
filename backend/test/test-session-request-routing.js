import assert from 'node:assert/strict';
import { apiClient, coordinateSessionRequests } from '../../src/api/ApiClient.js';
import { SessionRequestCoordinator, InactiveSessionResponse } from '../../src/api/SessionRequestCoordinator.mjs';
const saved = new Map(), deleted = new Set();
const store = { async isDeleted(id) { return deleted.has(id); }, async saveSession(session) { saved.set(session.id, structuredClone(session)); } };
let selected = 'a';
const coordinator = new SessionRequestCoordinator({ store, currentId: () => selected });
coordinateSessionRequests(coordinator);
const previousFetch = globalThis.fetch;
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
try {
  let capturedSignal;
  let finish = deferred(), started = deferred();
  let callbacks = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/sessions\/a\/message$/);
    assert.equal(JSON.parse(init.body).session.id, 'a');
    capturedSignal = init.signal;
    started.resolve();
    await finish.promise;
    return new Response('event: debug\ndata: {"content":"debug"}\n\nevent: done\ndata: {"session":{"id":"a","title":"completed"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const pending = apiClient.sendMessage({ id: 'a' }, '调查', { onDebug: () => callbacks++ });
  await started.promise;
  selected = 'b';
  finish.resolve();
  await assert.rejects(pending, InactiveSessionResponse);
  assert.equal(saved.get('a').title, 'completed');
  assert.equal(saved.has('b'), false);
  assert.equal(callbacks, 0, 'inactive callbacks cannot render in the new session');
  selected = 'a'; finish = deferred(); started = deferred(); saved.clear();
  const canceled = apiClient.sendMessage({ id: 'a' }, '调查');
  await started.promise;
  deleted.add('a'); coordinator.cancel('a');
  assert.equal(capturedSignal.aborted, true);
  finish.resolve(); // Simulate a server which still finishes after cancellation.
  await assert.rejects(canceled, InactiveSessionResponse);
  assert.equal(saved.size, 0);
  deleted.clear();
  globalThis.fetch = async () => Response.json({ session: { id: 'wrong' } });
  await assert.rejects(apiClient.saveWorld({ id: 'a' }), /标识不匹配/);
  assert.equal(saved.size, 0);
  console.log('API request identity, inactive SSE, cancellation and foreign-session rejection passed.');
} finally { globalThis.fetch = previousFetch; coordinateSessionRequests(null); }
