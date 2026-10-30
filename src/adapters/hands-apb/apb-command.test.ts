import { describe, expect, test } from 'bun:test';

import { apbMcpCommand } from './apb-command';

describe('apbMcpCommand', () => {
  test('starts apb mcp in the project root in CLI execution mode', () => {
    expect(apbMcpCommand('/bin/apb', '/projects/factory', {})).toEqual({
      command: '/bin/apb',
      args: ['mcp'],
      cwd: '/projects/factory',
      env: { APB_EXECUTION: 'cli' },
    });
  });

  test('passes the APB configuration location through when set, and nothing else', () => {
    const command = apbMcpCommand('apb', '/p', { APB_CONFIG_DIR: '/tmp/apb', XDG_CONFIG_HOME: '', OTHER: 'x' });
    expect(command.env).toEqual({ APB_EXECUTION: 'cli', APB_CONFIG_DIR: '/tmp/apb' });
  });

  test('passes XDG_CONFIG_HOME through when set', () => {
    expect(apbMcpCommand('apb', '/p', { XDG_CONFIG_HOME: '/cfg' }).env).toEqual({
      APB_EXECUTION: 'cli',
      XDG_CONFIG_HOME: '/cfg',
    });
  });
});
