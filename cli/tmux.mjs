import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const FIELDS = ['pane_id', 'session_id', 'session_name', 'socket_path', 'pane_dead',
  'pane_current_path', '@dag_session_id', 'pane_in_mode', 'pane_input_off', 'pane_synchronized'];
const FORMAT = FIELDS.map(key => `#{${key}}`).join('\t');

export class Tmux {
  constructor(socket = process.env.DAG_TMUX_SOCKET) { this.socket = socket; }

  static callerSocket() {
    // TMUX ends with ,server_pid,session_index; the path itself may contain commas.
    const value = process.env.TMUX;
    if (!value) return undefined;
    return value.slice(0, value.lastIndexOf(',', value.lastIndexOf(',') - 1));
  }

  run(args) {
    // tmux parses a trailing semicolon as a command separator even when it
    // receives argv directly. Escape that parser layer, without invoking sh.
    const literalArgs = args.map(arg => String(arg).replace(/;$/, '\\;'));
    const result = spawnSync('tmux', [...(this.socket ? ['-S', this.socket] : []), ...literalArgs], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (result.error) throw new Error(`tmux: ${result.error.message}`);
    if (result.status !== 0 || /^error (creating|connecting)/m.test(result.stderr)) {
      throw new Error(`tmux: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    return result.stdout.trimEnd();
  }

  pane(target) {
    const text = this.run(['display-message', '-p', '-t', target, FORMAT]);
    const values = text.split('\t');
    if (!/^%\d+$/.test(values[0]) || values.length !== FIELDS.length) throw new Error('Could not resolve tmux pane.');
    return Object.fromEntries(FIELDS.map((key, i) => [key, values[i]]));
  }

  bind(pane, id) { this.run(['set-option', '-p', '-t', pane, '@dag_session_id', id]); }

  inspect(session) {
    try {
      const pane = new Tmux(session.socket).pane(session.pane);
      const online = pane['@dag_session_id'] === session.id && pane.pane_dead === '0';
      return { online, pane };
    } catch (error) { return { online: false, error: error.message }; }
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
    tmux.run(['send-keys', '-l', '-t', session.pane, '--', text]);
    await delay(100);
    tmux.run(['send-keys', '-t', session.pane, 'Enter']);
  }
}
