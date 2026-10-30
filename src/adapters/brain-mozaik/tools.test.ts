import { describe, expect, test } from 'bun:test';

import { FunctionCallItem } from '@mozaik-ai/core';
import { z } from 'zod';

import { BrainError } from './errors';
import { parseFunctionCall, toFunctionTool, type ToolDeclaration } from './tools';

const weather: ToolDeclaration<{ city: string; days: number }> = {
  name: 'get_weather',
  description: 'Weather forecast for a city.',
  args: z.object({ city: z.string().min(1), days: z.number().int().positive() }),
};

function call(name: string, args: string): FunctionCallItem {
  return FunctionCallItem.rehydrate({ callId: 'call-1', name, args });
}

function invalid(run: () => unknown): BrainError {
  try {
    run();
  } catch (error) {
    if (error instanceof BrainError) return error;
    throw error;
  }
  throw new Error('expected an invalid-arguments error');
}

describe('toFunctionTool', () => {
  test('invoke validates the arguments before calling the handler', async () => {
    const seen: unknown[] = [];
    const tool = toFunctionTool(weather, async (args) => {
      seen.push(args);
      return 'sunny';
    });
    expect(await tool.invoke({ city: 'Oslo', days: 2 })).toBe('sunny');
    expect(seen).toEqual([{ city: 'Oslo', days: 2 }]);
    await expect(tool.invoke({ city: 'Oslo' })).rejects.toBeInstanceOf(BrainError);
    expect(seen).toHaveLength(1);
  });

  test('the advertised schema describes the input, so a defaulted field is not required', () => {
    const forecast: ToolDeclaration<{ city: string; days: number }> = {
      name: 'get_forecast',
      description: 'Forecast with a default horizon.',
      args: z.object({ city: z.string(), days: z.number().int().default(3) }),
    };
    const { parameters } = toFunctionTool(forecast, async () => 'ok');
    expect(parameters['required']).toEqual(['city']);
  });
});

describe('parseFunctionCall', () => {
  const bad: [string, FunctionCallItem][] = [
    ['malformed JSON', call('get_weather', '{"city":')],
    ['a schema mismatch', call('get_weather', '{"city":"Oslo","days":"three"}')],
    ['an unknown tool', call('get_time', '{}')],
  ];
  for (const [name, item] of bad) {
    test(`${name} is an invalid-arguments error naming the tool`, () => {
      const error = invalid(() => parseFunctionCall(item, [weather]));
      expect(error.kind).toBe('invalid_arguments');
      expect(error.tool).toBe(item.name);
      expect(error.message).toContain(item.name);
    });
  }
});
