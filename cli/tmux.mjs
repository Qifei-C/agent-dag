import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { uptime } from 'node:os';

const FIELDS = ['pane_id', 'session_id', 'session_name', 'socket_path', 'pane_dead',
  'pane_current_path', '@dag_session_id', 'pane_in_mode', 'pane_input_off', 'pane_synchronized'];
const FORMAT = FIELDS.map(key => `#{${key}}`).join('\t');

// Only proof of absence counts as gone, because auto-removal acts on this answer.
// Timeouts, a missing client binary and permission errors say nothing about the
// pane. A missing socket is not proof either: a private /tmp or a tmp cleaner hides
// a live server's socket. See predatesBoot for the case where it is conclusive.
const GONE = /no server running|error connecting to .* \(Connection refused\)|can't find (?:pane|window|session)/;
const MISSING_SOCKET = /error connecting to .* \(No such file or directory\)/;
const INSPECT_TIMEOUT_MS = 2000;
export const isGoneError = message => GONE.test(message);

// No tmux server survives a reboot, so a record untouched since before this boot
// cannot have a live pane however its socket looks.
const predatesBoot = session => Date.parse(session.updatedAt) < Date.now() - uptime() * 1000;

export class Tmux {
  constructor(socket = process.env.DAG_TMUX_SOCKET) { this.socket = socket; }

  static callerSocket() {
    // TMUX ends with ,server_pid,session_index; the path itself may contain commas.
    const value = process.env.TMUX;
    if (!value) return undefined;
    return value.slice(0, value.lastIndexOf(',', value.lastIndexOf(',') - 1));
  }

  run(args, { timeout = 10000 } = {}) {
    // tmux parses a trailing semicolon as a command separator even when it
    // receives argv directly. Escape that parser layer, without invoking sh.
    const literalArgs = args.map(arg => String(arg).replace(/;$/, '\\;'));
    const result = spawnSync('tmux', [...(this.socket ? ['-S', this.socket] : []), ...literalArgs], {
      encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    });
    if (result.error) throw new Error(`tmux: ${result.error.message}`);
    if (result.status !== 0 || /^error (creating|connecting)/m.test(result.stderr)) {
      throw new Error(`tmux: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    return result.stdout.trimEnd();
  }

  pane(target, options) {
    const text = this.run(['display-message', '-p', '-t', target, FORMAT], options);
    const values = text.split('\t');
    // A live server answers a missing pane with status 0 and empty pane fields.
    if (values[0] === '') throw Object.assign(new Error('Could not resolve tmux pane.'), { gone: true });
    if (!/^%\d+$/.test(values[0]) || values.length !== FIELDS.length) throw new Error('Could not resolve tmux pane.');
    return Object.fromEntries(FIELDS.map((key, i) => [key, values[i]]));
  }

  bind(pane, id) { this.run(['set-option', '-p', '-t', pane, '@dag_session_id', id]); }

  unbind(session) {
    const { pane } = this.inspect(session);
    // Offline includes dead panes and panes now owned by another registration.
    // Clear only our own binding, even when its process has already exited.
    if (pane?.['@dag_session_id'] === session.id) {
      new Tmux(session.socket).run(['set-option', '-p', '-u', '-t', session.pane, '@dag_session_id']);
    }
  }

  inspect(session) {
    try {
      const pane = new Tmux(session.socket).pane(session.pane, { timeout: INSPECT_TIMEOUT_MS });
      const online = pane['@dag_session_id'] === session.id && pane.pane_dead === '0';
      return { online, offline: !online, pane };
    } catch (error) {
      const offline = error.gone === true || isGoneError(error.message)
        || (MISSING_SOCKET.test(error.message) && predatesBoot(session));
      return { online: false, offline, timedOut: /ETIMEDOUT/.test(error.message), error: error.message };
    }
  }

  async inject(session, text) {
    const tmux = new Tmux(session.socket);
    const { online, pane } = tmux.inspect(session);
    if (!online) throw new Error('Receiver pane is offline or no longer belongs to this session.');
    if (pane.pane_in_mode !== '0' || pane.pane_input_off !== '0' || pane.pane_synchronized !== '0') {
      throw new Error('Receiver pane is in copy mode, has input disabled, or synchronizes input to other panes.');
    }
    // The envelope is one JSON-escaped line. No message content is interpreted
    // as tmux keys, shell syntax, control codes, or an extra Return.
    // Explicit bracketed paste avoids classifying the trailing Enter as part
    // of a synthetic typing burst. Codex 0.163.0 suppresses Enter for 120ms;
    // the former 100ms delay could leave a message in the composer forever.
    // Use a private, one-shot buffer, never the user's default paste buffer.
    const buffer = `dag-${randomUUID()}`;
    tmux.run(['set-buffer', '-b', buffer, '--', text]);
    try {
      tmux.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', session.pane]);
    } catch (error) {
      try { tmux.run(['delete-buffer', '-b', buffer]); } catch {}
      throw error;
    }
    await delay(750);
    tmux.run(['send-keys', '-t', session.pane, 'Enter']);
  }
}
