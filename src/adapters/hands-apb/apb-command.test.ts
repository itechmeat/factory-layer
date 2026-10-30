import { describe, expect, test } from 'bun:test';

import { apbMcpCommand } from './apb-command';

describe('apbMcpCommand', () => {
  test('starts apb mcp in the project root in CLI execution mode, with CLAUDE.md loading off for the agents', () => {
    expect(apbMcpCommand('/bin/apb', '/projects/factory', {})).toEqual({
      command: '/bin/apb',
      args: ['mcp'],
      cwd: '/projects/factory',
      env: { APB_EXECUTION: 'cli', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    });
  });

  test('passes the APB configuration location through when set, and nothing else', () => {
    const command = apbMcpCommand('apb', '/p', { APB_CONFIG_DIR: '/tmp/apb', XDG_CONFIG_HOME: '', OTHER: 'x' });
    expect(command.env).toEqual({ APB_EXECUTION: 'cli', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', APB_CONFIG_DIR: '/tmp/apb' });
  });

  test('passes XDG_CONFIG_HOME through when set', () => {
    expect(apbMcpCommand('apb', '/p', { XDG_CONFIG_HOME: '/cfg' }).env).toEqual({
      APB_EXECUTION: 'cli',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      XDG_CONFIG_HOME: '/cfg',
    });
  });

  test('never passes a provider key or the Anthropic names to apb mcp', () => {
    const env = {
      ZAI_API_KEY: 'k1',
      FALLBACK_API_KEY: 'k2',
      JIGJOY_ANTHROPIC_API_KEY: 'k3',
      JIGJOY_ANTHROPIC_BASE_URL: 'https://gateway.test',
      ANTHROPIC_API_KEY: 'k4',
      ANTHROPIC_BASE_URL: 'https://gateway.test',
    };
    expect(apbMcpCommand('apb', '/p', env).env).toEqual({ APB_EXECUTION: 'cli', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
  });
});
