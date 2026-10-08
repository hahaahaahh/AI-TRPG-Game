const DB_NAME = 'ai-trpg-game';
const DB_VERSION = 2;
const STORE_NAME = 'sessions';
const DELETIONS = 'deletedSessions';
export class DeletedSessionError extends Error {
  constructor(id) { super('该会话已删除，迟到的结果不会恢复它。'); this.name = 'DeletedSessionError'; this.sessionId = id; }
}
const RECOVERABLE_SUB_STATES = new Set(['LLM_STREAMING', 'SUMMARIZING']);

function openDb() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DELETIONS)) db.createObjectStore(DELETIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => { blocked = true; reject(new Error('存储升级被旧标签页阻塞，请关闭其他游戏标签后重试。')); };
    request.onerror = () => reject(request.error);
  });
}

// All record creation and deletion share these stores, so concurrent tabs cannot
// interleave a marker check with a subsequent write. Never prune tombstones.
async function writeSession(id, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, DELETIONS], 'readwrite');
    const sessions = tx.objectStore(STORE_NAME), markers = tx.objectStore(DELETIONS);
    let failure;
    if (value === null) {
      markers.put({ id, deletedAt: new Date().toISOString() });
      sessions.delete(id);
    } else {
      const check = markers.get(id);
      check.onsuccess = () => {
        if (check.result) { failure = new DeletedSessionError(id); tx.abort(); }
        else sessions.put(value);
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure || tx.error || new Error('存储事务失败')); };
  });
}

function runStore(mode, fn) {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = fn(store);
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('保存事务已取消')); };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function normalizeSession(session) {
  const now = new Date().toISOString();
  const recoveredSubState = RECOVERABLE_SUB_STATES.has(session.subState)
    ? 'AWAITING_INPUT'
    : session.subState || 'AWAITING_INPUT';

  return {
    id: session.id,
    title: session.title || '新剧本',
    llmProfileId: session.llmProfileId ?? null,
    phase: session.phase || 'WORLD_SETTING',
    subState: recoveredSubState,
    openingDone: Boolean(session.openingDone),
    worldSettings: session.worldSettings || '',
    player: session.player || '',
    keyCharacters: session.keyCharacters || [],
    keyCharacterIndex: session.keyCharacterIndex ?? 0,
    keyCharSetupHistory: session.keyCharSetupHistory || [],
    chatRecord: session.chatRecord || [],
    setupHistory: session.setupHistory || { world: [], character: [] },
    displayLog: session.displayLog || [],
    optionBuffer: session.optionBuffer || '',
    locations: session.locations || [],
    npcs: session.npcs || [],
    inventory: session.inventory || [],
    pendingDiceFlow: recoveredSubState === 'AWAITING_INPUT'
      ? null
      : session.pendingDiceFlow || null,
    // DeepSeek 官方要求：思考模式 + 工具调用场景下，后续轮次必须回传 reasoning_content
    // 因此持久化保留最近 10 条 reasoning_content，避免会话刷新后丢失导致 API 行为异常
    recentReasoningContents: Array.isArray(session.recentReasoningContents)
      ? session.recentReasoningContents.slice(-10)
      : [],
    // 新手试炼的时间驱动状态必须与普通会话一起持久化。
    // 此前 normalizeSession 丢弃这些字段，导致 API 已创建的试炼会话
    // 一写入 IndexedDB 就退化为没有时钟的普通会话。
    scenarioId: session.scenarioId ?? null,
    scenarioSource: session.scenarioSource ?? (session.scenarioId ? 'authored' : null),
    scenarioDefinition: session.scenarioDefinition ?? null,
    scenarioSchemaVersion: session.scenarioSchemaVersion ?? null,
    investigationSetup: session.investigationSetup ?? null,
    generationStatus: session.generationStatus ?? null,
    scenarioPreparation: session.scenarioPreparation ?? null,
    storyOpeningCache: session.storyOpeningCache ?? null,
    characterInitialStats: session.characterInitialStats ?? null,
    scenarioRules: session.scenarioRules ?? null,
    scenarioClock: session.scenarioClock ?? null,
    playerLocationId: session.playerLocationId ?? null,
    sanity: session.sanity ?? null,
    scheduledEvents: Array.isArray(session.scheduledEvents) ? session.scheduledEvents : [],
    activeScene: session.activeScene ?? null,
    scenarioFlags: session.scenarioFlags && typeof session.scenarioFlags === 'object'
      ? session.scenarioFlags
      : {},
    evidence: Array.isArray(session.evidence) ? session.evidence : [],
    suspicion: Number.isFinite(session.suspicion) ? session.suspicion : 0,
    combat: session.combat ?? null,
    finalChoice: session.finalChoice ?? null,
    endingState: session.endingState ?? null,
    finaleState: session.finaleState ?? null,
    createdAt: session.createdAt || now,
    updatedAt: session.updatedAt || now,
    sortOrder: session.sortOrder ?? Date.now(),
  };
}

export class SessionStore {
  constructor() {
    this.listeners = new Set();
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ai-trpg-session-deletions') : null;
    this.channel?.unref?.(); // Do not keep Node-based regression tests alive.
    if (this.channel) this.channel.onmessage = event => {
      if (event.data?.type === 'deleted' && typeof event.data.id === 'string') this._notifyDeletion(event.data.id);
    };
  }

  onDelete(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  _notifyDeletion(id) { for (const listener of this.listeners) Promise.resolve().then(() => listener(id)).catch(console.error); }
  close() { this.channel?.close(); this.listeners.clear(); }
  async isDeleted(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DELETIONS, 'readonly');
      const request = tx.objectStore(DELETIONS).get(id);
      tx.oncomplete = () => { db.close(); resolve(!!request.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async listSessions() {
    const sessions = await runStore('readonly', store => store.getAll());
    return sessions
      .map(normalizeSession)
      .sort((a, b) => b.sortOrder - a.sortOrder);
  }

  async getSession(id) {
    const session = await runStore('readonly', store => store.get(id));
    return session ? normalizeSession(session) : null;
  }

  async saveSession(session) {
    const normalized = normalizeSession({
      ...session,
      updatedAt: new Date().toISOString(),
    });
    if (!normalized.id) throw new Error('会话缺少标识，无法保存。');
    await writeSession(normalized.id, normalized);
    return normalized;
  }

  /**
   * 交换两个会话的 sortOrder，持久化排序变更。
   * @param {string} idA 被拖拽的会话 id
   * @param {string} idB 目标位置的会话 id
   */
  async swapSessionOrder(idA, idB) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const reqA = store.get(idA);
      reqA.onsuccess = () => {
        const reqB = store.get(idB);
        reqB.onsuccess = () => {
          const sessionA = reqA.result;
          const sessionB = reqB.result;
          if (!sessionA || !sessionB) {
            db.close();
            return reject(new Error('Session not found'));
          }
          const tmp = sessionA.sortOrder ?? Date.now();
          sessionA.sortOrder = sessionB.sortOrder ?? Date.now();
          sessionB.sortOrder = tmp;
          store.put(sessionA);
          store.put(sessionB);
        };
        reqB.onerror = () => { db.close(); reject(reqB.error); };
      };
      reqA.onerror = () => { db.close(); reject(reqA.error); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async createSession(title = '新剧本') {
    const now = new Date().toISOString();
    const session = normalizeSession({
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    });
    return this.saveSession(session);
  }

  async deleteSession(id) {
    await writeSession(id, null);
    // UI hints cannot turn an already committed deletion into a reported failure.
    try {
      if (localStorage.getItem('ai-trpg-current-session-id') === id) localStorage.removeItem('ai-trpg-current-session-id');
      this.channel?.postMessage({ type: 'deleted', id });
    } catch (error) { console.warn('会话已删除，但同步提示发送失败。', error); }
    this._notifyDeletion(id);
  }

  getCurrentSessionId() {
    return localStorage.getItem('ai-trpg-current-session-id');
  }
}

export const sessionStore = new SessionStore();
