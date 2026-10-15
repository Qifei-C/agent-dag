import { test, expect } from 'claude-code/testing'

test('the module loads and session.start passes through', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const started = await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
  expect(started.cwd).toBe('/tmp/x')
})
