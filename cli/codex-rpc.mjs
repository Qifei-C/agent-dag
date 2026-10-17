import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import WebSocket from 'ws';

/** Codex App Server JSON-RPC over its documented Unix WebSocket transport. */
export class CodexRpc extends EventEmitter {
  constructor(socketPath, { timeout = 10000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.ws = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection(this.socketPath),
      handshakeTimeout: this.timeout, maxPayload: 16 * 1024 * 1024,
    });
    this.ws.on('message', data => this.receive(data));
    this.ws.on('error', error => this.emit('connectionError', error));
    this.ws.on('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex App Server disconnected.'));
      }
      this.pending.clear();
      this.emit('disconnect');
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'agent_dag', title: 'Agent DAG', version: '0.3.0' },
        capabilities: { experimentalApi: false },
      });
      this.notify('initialized');
      return this;
    } catch (error) { this.close(); throw error; }
  }

  receive(data) {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { this.emit('connectionError', new Error('Invalid Codex JSON-RPC message.')); return; }
    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    } else if (message.id !== undefined) {
      // Observers never decide approvals or answer user questions on the
      // native TUI's behalf. Leave them for the owning Codex client.
      this.emit('serverRequest', message);
    } else if (message.method) this.emit('notification', message);
  }

  request(method, params = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex App Server is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) { this.ws.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) })); }
  close() { this.ws?.terminate(); }
}
