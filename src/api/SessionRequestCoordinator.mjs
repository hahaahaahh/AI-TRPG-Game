export class InactiveSessionResponse extends Error {
  constructor() { super('后台会话结果已处理。'); this.name = 'InactiveSessionResponse'; this.silent = true; }
}

// Request identity, not current selection, owns every asynchronous result.
export class SessionRequestCoordinator {
  constructor({ store, currentId, onStored = () => {} }) {
    this.store = store; this.currentId = currentId; this.onStored = onStored;
    this.pending = new Map();
  }
  cancel(id) { this.pending.get(id)?.controller.abort(); }
  isPending(id) { return this.pending.has(id); }
  async run(session, execute, { allowNewSession = false } = {}) {
    const id = session.id;
    if (this.pending.has(id)) throw new Error('该会话仍有请求正在进行，请稍候。');
    if (await this.store.isDeleted(id)) throw new InactiveSessionResponse();
    // Recheck after the asynchronous read, before acquiring ownership.
    if (this.pending.has(id)) throw new Error('该会话仍有请求正在进行，请稍候。');
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    this.pending.set(id, request);
    const visible = () => this.pending.get(id) === request && this.currentId() === id && !request.controller.signal.aborted;
    try {
      const response = await execute(request.controller.signal, visible);
      if (this.pending.get(id) !== request || request.controller.signal.aborted || await this.store.isDeleted(id)) throw new InactiveSessionResponse();
      if (response.session) {
        if (response.session.id !== id && !allowNewSession) throw new Error('响应会话标识不匹配，未保存结果。');
        // Restart is allowed to produce a new id, but deletion of its originating
        // run still invalidates the response. Ordinary endpoints cannot rebind.
        await this.store.saveSession(response.session);
        await this.onStored(response.session.id);
      }
      if (!visible()) throw new InactiveSessionResponse();
      return response;
    } catch (error) {
      if (!visible() || error.name === 'DeletedSessionError') throw new InactiveSessionResponse();
      throw error;
    } finally {
      if (this.pending.get(id) === request) this.pending.delete(id);
    }
  }
}
