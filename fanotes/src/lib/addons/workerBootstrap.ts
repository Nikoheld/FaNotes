// Source of the SDK that runs inside every add-on worker. It is shipped as a
// string so the host can spawn it from a blob: URL (allowed by the CSP
// `worker-src 'self' blob:`) without any build step. Keep it dependency-free,
// free of template literals (it lives inside String.raw) and defensive: a
// misbehaving add-on must never be able to break the message loop.
//
// The public surface it builds (`self.fanotes`) is documented in
// fanotes-addons/sdk/fanotes-addon.d.ts and fanotes-addons/docs/API.md.

export const ADDON_WORKER_BOOTSTRAP = String.raw`
'use strict';
(() => {
  const pending = new Map();
  let sequence = 0;
  let context = { appVersion: '', platform: '', language: 'de', apiVersion: 1, web: false };
  let addonInfo = { id: '', name: '', version: '', permissions: [] };
  const commands = new Map();
  const panels = new Map();
  const listeners = new Map();
  const activateHooks = [];
  const deactivateHooks = [];
  let activated = false;
  let moduleExports = null;

  const serializeError = (error) => {
    if (error instanceof Error) {
      return { name: error.name || 'Error', message: error.message || String(error), stack: typeof error.stack === 'string' ? error.stack.slice(0, 4000) : undefined, code: typeof error.code === 'string' ? error.code : undefined };
    }
    if (error && typeof error === 'object') {
      return { name: String(error.name || 'Error'), message: String(error.message || JSON.stringify(error)).slice(0, 2000), code: typeof error.code === 'string' ? error.code : undefined };
    }
    return { name: 'Error', message: String(error === undefined ? 'Unknown error' : error) };
  };

  const post = (message) => {
    try {
      self.postMessage(message);
    } catch (error) {
      try {
        self.postMessage({ t: 'log', level: 'error', text: 'Unserialisable message: ' + (error && error.message ? error.message : String(error)) });
      } catch (_) { /* nothing left to do */ }
    }
  };

  class FaNotesError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'FaNotesError';
      this.code = code;
    }
  }

  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    post({ t: 'call', id, method, args: Array.isArray(args) ? args : [] });
  });

  const api = (namespace, names) => {
    const target = {};
    for (const name of names) {
      target[name] = (...args) => call(namespace + '.' + name, args);
    }
    return target;
  };

  const disposable = (dispose) => ({ dispose: () => { try { dispose(); } catch (_) { /* ignore */ } } });

  const notes = api('notes', ['list', 'tree', 'read', 'search', 'active', 'exists', 'write', 'append', 'create', 'open']);
  const vault = api('vault', ['createFolder', 'rename', 'move', 'trash']);
  const editor = api('editor', ['getText', 'getSelection', 'insert', 'replaceSelection', 'setText', 'format']);
  const ink = api('ink', ['read']);
  const stats = api('stats', ['read']);
  const settings = api('settings', ['read']);
  const clipboard = api('clipboard', ['writeText']);
  const storage = api('storage', ['get', 'set', 'remove', 'keys', 'clear']);

  const net = {
    fetch: async (url, init) => {
      const options = init && typeof init === 'object' ? init : {};
      const response = await call('net.fetch', [String(url), {
        method: options.method ? String(options.method) : 'GET',
        headers: options.headers && typeof options.headers === 'object' ? options.headers : {},
        body: typeof options.body === 'string' ? options.body : undefined,
      }]);
      const text = String(response.body || '');
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: String(response.statusText || ''),
        headers: response.headers || {},
        url: String(response.url || url),
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    },
  };

  const commandsApi = {
    register: (spec) => {
      if (!spec || typeof spec !== 'object') throw new FaNotesError('E_ARGS', 'commands.register needs { id, title, run }');
      const id = String(spec.id || '');
      if (typeof spec.run !== 'function') throw new FaNotesError('E_ARGS', 'commands.register: "run" must be a function');
      commands.set(id, spec.run);
      const promise = call('commands.register', [{ id, title: String(spec.title || id), detail: spec.detail == null ? undefined : String(spec.detail), keywords: spec.keywords == null ? undefined : String(spec.keywords), shortcut: spec.shortcut == null ? undefined : String(spec.shortcut) }]);
      promise.catch((error) => { commands.delete(id); console.error('[fanotes] commands.register failed for ' + id + ':', error && error.message ? error.message : error); });
      return disposable(() => { commands.delete(id); call('commands.unregister', [id]).catch(() => {}); });
    },
    execute: (id, ...args) => call('commands.execute', [String(id), args]),
    list: () => call('commands.list', []),
  };

  const makePanel = (spec) => {
    if (!spec || typeof spec !== 'object') throw new FaNotesError('E_ARGS', 'ui.panel needs { id, title, blocks }');
    const id = String(spec.id || 'main');
    const state = { onAction: typeof spec.onAction === 'function' ? spec.onAction : null, onInput: typeof spec.onInput === 'function' ? spec.onInput : null, values: {} };
    panels.set(id, state);
    const handle = {
      id,
      update: (blocks) => call('ui.panel.update', [id, blocks]),
      setTitle: (title) => call('ui.panel.show', [{ id, title: String(title), blocks: undefined }]),
      show: () => call('ui.panel.show', [{ id, title: String(spec.title || addonInfo.name), icon: spec.icon == null ? undefined : String(spec.icon), blocks: spec.blocks, focus: true }]),
      close: () => { panels.delete(id); return call('ui.panel.close', [id]); },
      onAction: (handler) => { state.onAction = typeof handler === 'function' ? handler : null; return handle; },
      onInput: (handler) => { state.onInput = typeof handler === 'function' ? handler : null; return handle; },
      values: () => ({ ...state.values }),
    };
    return handle;
  };

  const ui = {
    toast: (message, kind) => call('ui.toast', [String(message), kind == null ? 'info' : String(kind)]),
    confirm: (message, options) => call('ui.confirm', [String(message), options && typeof options === 'object' ? options : {}]),
    prompt: (message, options) => call('ui.prompt', [String(message), options && typeof options === 'object' ? options : {}]),
    openExternal: (url) => call('ui.openExternal', [String(url)]),
    panel: (spec) => {
      const handle = makePanel(spec);
      const shown = call('ui.panel.show', [{ id: handle.id, title: String(spec.title || addonInfo.name), icon: spec.icon == null ? undefined : String(spec.icon), blocks: spec.blocks, focus: spec.focus !== false }]);
      shown.catch((error) => console.error('[fanotes] ui.panel failed:', error && error.message ? error.message : error));
      return handle;
    },
    status: {
      set: (item) => {
        if (!item || typeof item !== 'object') throw new FaNotesError('E_ARGS', 'ui.status.set needs { id, text }');
        const id = String(item.id || 'status');
        if (typeof item.onClick === 'function') commands.set('status:' + id, item.onClick);
        return call('ui.status.set', [{ id, text: String(item.text || ''), title: item.title == null ? undefined : String(item.title), clickable: typeof item.onClick === 'function' }]);
      },
      remove: (id) => { commands.delete('status:' + String(id)); return call('ui.status.remove', [String(id)]); },
    },
  };

  const events = {
    on: (name, handler) => {
      const key = String(name);
      if (typeof handler !== 'function') throw new FaNotesError('E_ARGS', 'events.on needs a handler function');
      if (!listeners.has(key)) {
        listeners.set(key, new Set());
        call('events.subscribe', [key]).catch((error) => console.error('[fanotes] events.on(' + key + ') rejected:', error && error.message ? error.message : error));
      }
      listeners.get(key).add(handler);
      return disposable(() => {
        const set = listeners.get(key);
        if (!set) return;
        set.delete(handler);
        if (!set.size) { listeners.delete(key); call('events.unsubscribe', [key]).catch(() => {}); }
      });
    },
    once: (name, handler) => {
      let sub = null;
      sub = events.on(name, (payload) => { if (sub) sub.dispose(); handler(payload); });
      return sub;
    },
  };

  const fanotes = Object.freeze({
    get app() { return { ...context, addon: { ...addonInfo } }; },
    onActivate: (hook) => { if (typeof hook === 'function') { if (activated) Promise.resolve().then(() => hook(fanotes)).catch(reportError); else activateHooks.push(hook); } },
    onDeactivate: (hook) => { if (typeof hook === 'function') deactivateHooks.push(hook); },
    hasPermission: (permission) => addonInfo.permissions.includes(String(permission)),
    log: (...args) => post({ t: 'log', level: 'log', text: args.map(stringify).join(' ').slice(0, 4000) }),
    notes, vault, editor, ink, stats, settings, clipboard, storage, net, ui, events,
    commands: commandsApi,
    FaNotesError,
  });

  function stringify(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function reportError(error) {
    post({ t: 'error', error: serializeError(error) });
  }

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level] ? console[level].bind(console) : null;
    console[level] = (...args) => {
      if (original) { try { original(...args); } catch (_) { /* ignore */ } }
      post({ t: 'log', level, text: args.map(stringify).join(' ').slice(0, 4000) });
    };
  }

  self.addEventListener('error', (event) => {
    reportError(event && event.error ? event.error : new Error(event && event.message ? event.message : 'Worker error'));
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  });
  self.addEventListener('unhandledrejection', (event) => {
    reportError(event && event.reason !== undefined ? event.reason : new Error('Unhandled rejection'));
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  });

  const runInvoke = async (message) => {
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    switch (message.kind) {
      case 'activate': {
        activated = true;
        const hooks = activateHooks.splice(0, activateHooks.length);
        if (moduleExports) {
          const fn = typeof moduleExports.activate === 'function' ? moduleExports.activate : typeof moduleExports.default === 'function' ? moduleExports.default : null;
          if (fn) hooks.unshift(fn);
        }
        for (const hook of hooks) await hook(fanotes);
        return { commands: [...commands.keys()].filter((key) => !key.startsWith('status:')), listeners: [...listeners.keys()] };
      }
      case 'deactivate': {
        const hooks = deactivateHooks.splice(0, deactivateHooks.length);
        if (moduleExports && typeof moduleExports.deactivate === 'function') hooks.push(moduleExports.deactivate);
        for (const hook of hooks) { try { await hook(fanotes); } catch (error) { reportError(error); } }
        return true;
      }
      case 'command': {
        const run = commands.get(String(payload.id));
        if (!run) throw new FaNotesError('E_NO_COMMAND', 'Unknown command: ' + String(payload.id));
        return await run(...(Array.isArray(payload.args) ? payload.args : []));
      }
      case 'event': {
        const set = listeners.get(String(payload.name));
        if (!set) return false;
        for (const handler of [...set]) {
          try { await handler(payload.data); } catch (error) { reportError(error); }
        }
        return true;
      }
      case 'action': {
        const panel = panels.get(String(payload.panelId));
        if (!panel) return false;
        if (payload.values && typeof payload.values === 'object') panel.values = { ...panel.values, ...payload.values };
        if (panel.onAction) await panel.onAction({ id: String(payload.actionId), itemId: payload.itemId == null ? undefined : String(payload.itemId), values: { ...panel.values } });
        return true;
      }
      case 'input': {
        const panel = panels.get(String(payload.panelId));
        if (!panel) return false;
        panel.values[String(payload.inputId)] = payload.value;
        if (panel.onInput) await panel.onInput({ id: String(payload.inputId), value: payload.value, values: { ...panel.values } });
        return true;
      }
      default:
        throw new FaNotesError('E_UNKNOWN_INVOKE', 'Unknown invoke kind: ' + String(message.kind));
    }
  };

  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.t === 'reply') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else {
        const error = new FaNotesError(message.error && message.error.code ? message.error.code : 'E_HOST', message.error && message.error.message ? message.error.message : 'Host rejected the call');
        entry.reject(error);
      }
      return;
    }
    if (message.t === 'ping') { post({ t: 'pong', id: message.id }); return; }
    if (message.t === 'invoke') {
      Promise.resolve()
        .then(() => runInvoke(message))
        .then((value) => post({ t: 'result', id: message.id, ok: true, value: value === undefined ? null : value }))
        .catch((error) => post({ t: 'result', id: message.id, ok: false, error: serializeError(error) }));
      return;
    }
    if (message.t === 'init') {
      context = { ...context, ...(message.context || {}) };
      addonInfo = { ...addonInfo, ...(message.addon || {}) };
      self.fanotes = fanotes;
      import(message.codeUrl)
        .then((mod) => {
          moduleExports = mod && typeof mod === 'object' ? mod : null;
          post({ t: 'ready', exports: moduleExports ? Object.keys(moduleExports) : [] });
        })
        .catch((error) => post({ t: 'fatal', error: serializeError(error) }));
    }
  });
})();
`
