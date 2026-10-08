import assert from 'node:assert/strict';
import { indexedDB, IDBDatabase } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
globalThis.indexedDB = indexedDB;
globalThis.crypto ||= webcrypto;
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
// Upgrade a real v1-shaped database, not a fresh v2 database only.
await new Promise((resolve, reject) => {
  const request = indexedDB.open('ai-trpg-game', 1);
  request.onupgradeneeded = () => {
    const sessions = request.result.createObjectStore('sessions', { keyPath: 'id' });
    sessions.createIndex('updatedAt', 'updatedAt');
    sessions.put({ id: 'legacy', title: '旧存档', subState: 'RESTART_PENDING', endingState: { finished: true }, finaleState: { stage: 'complete' } });
  };
  request.onsuccess = () => { request.result.close(); resolve(); };
  request.onerror = () => reject(request.error);
});
const { SessionStore, sessionStore } = await import('../../src/persistence/SessionStore.js');
const { SessionRequestCoordinator, InactiveSessionResponse } = await import('../../src/api/SessionRequestCoordinator.mjs');
const store = new SessionStore(), otherTab = new SessionStore();
try {
  assert.equal((await store.getSession('legacy')).finaleState.stage, 'complete');
  const session = await store.createSession('调查');
  localStorage.setItem('ai-trpg-current-session-id', 'legacy');
  await store.saveSession(session);
  assert.equal(localStorage.getItem('ai-trpg-current-session-id'), 'legacy', 'background save must not select a run');
  for (let i = 0; i < 20; i++) {
    const run = await store.createSession('race');
    const writes = i % 2 ? [store.deleteSession(run.id), otherTab.saveSession(run)] : [otherTab.saveSession(run), store.deleteSession(run.id)];
    await Promise.allSettled(writes);
    assert.equal(await store.getSession(run.id), null);
    await assert.rejects(otherTab.saveSession(run), { name: 'DeletedSessionError' });
  }
  let selected = session.id;
  const coordinator = new SessionRequestCoordinator({ store, currentId: () => selected });
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  const waitStarted = async id => { while (!coordinator.isPending(id)) await new Promise(r => setTimeout(r, 0)); };
  for (const phase of ['narration', 'dice', 'generation']) {
    const run = await store.createSession(phase); selected = run.id;
    const delay = deferred();
    const pending = coordinator.run(run, () => delay.promise);
    await waitStarted(run.id);
    await otherTab.deleteSession(run.id);
    delay.resolve({ session: { ...run, title: 'late result' } });
    await assert.rejects(pending, InactiveSessionResponse);
    assert.equal(await store.getSession(run.id), null);
  }
  selected = session.id;
  const delay = deferred();
  const pending = coordinator.run(session, () => delay.promise);
  await waitStarted(session.id);
  await assert.rejects(coordinator.run(session, () => delay.promise), /仍有请求/);
  selected = 'legacy';
  delay.resolve({ session: { ...session, title: '后台已完成' } });
  await assert.rejects(pending, InactiveSessionResponse);
  assert.equal((await store.getSession(session.id)).title, '后台已完成');
  assert.equal(localStorage.getItem('ai-trpg-current-session-id'), 'legacy');
  await store.deleteSession(session.id);
  const replay = { ...session, id: crypto.randomUUID() };
  await store.saveSession(replay);
  assert.ok(await otherTab.getSession(replay.id));
  const reload = new SessionStore();
  try { await assert.rejects(reload.saveSession(session), { name: 'DeletedSessionError' }); }
  finally { reload.close(); }
  // Failure before opening a transaction must never produce a deletion notice.
  let notifications = 0;
  const off = store.onDelete(() => notifications++);
  const oldDb = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error('模拟存储故障'); } };
  await assert.rejects(store.deleteSession(replay.id), /模拟存储故障/);
  globalThis.indexedDB = oldDb;
  off();
  assert.equal(notifications, 0);
  assert.ok(await store.getSession(replay.id));
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
    const tx = originalTransaction.call(this, names, mode, ...rest);
    if (mode === 'readwrite' && Array.isArray(names) && names.includes('deletedSessions')) queueMicrotask(() => tx.abort());
    return tx;
  };
  try { await assert.rejects(store.deleteSession(replay.id)); }
  finally { IDBDatabase.prototype.transaction = originalTransaction; }
  assert.ok(await store.getSession(replay.id), 'aborted deletion preserves the record');
  assert.equal(await store.isDeleted(replay.id), false, 'aborted deletion rolls back its marker too');
  console.log('Session deletion: migration, atomic races, late requests, inactive saves, reload, replay and failure passed.');
} finally { store.close(); otherTab.close(); sessionStore.close(); }
