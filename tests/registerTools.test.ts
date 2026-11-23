import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { NativeToolSpec, ToolsAccessor } from '@omadia/plugin-api';
import { z } from 'zod';

import { registerToolkit, toNativeToolSpec } from '../src/registerTools.js';
import { createToolkit, type ToolDescriptor, type Toolkit } from '../src/toolkit.js';
import { createLog, createMockLinear, createTurns } from './fixtures.js';

/**
 * The tool spec is the one text the calling agent's model reads before a
 * call, and the kernel sends it verbatim to the model provider. What it must
 * carry is checked here on the real tools: the schema the model fills in has
 * to be the schema `run` accepts.
 */

function toolkitOf(writeMode: 'confirm' | 'direct' | 'off' = 'confirm'): Toolkit {
  return createToolkit({
    client: createMockLinear().client,
    defaultTeamKey: 'OMA',
    writeMode,
    caller: createTurns().caller,
    log: createLog().log,
  });
}

function specOf(id: string, writeMode: 'confirm' | 'direct' | 'off' = 'confirm'): NativeToolSpec {
  const tool = toolkitOf(writeMode).tools.find((t) => t.id === id);
  assert.ok(tool, `no tool '${id}' in write mode ${writeMode}`);
  return toNativeToolSpec(tool);
}

function property(spec: NativeToolSpec, name: string): Record<string, unknown> {
  const value = spec.input_schema.properties[name];
  assert.ok(value !== null && typeof value === 'object', `property '${name}' missing`);
  return Object.fromEntries(Object.entries(value));
}

/** A tools accessor that records registrations and can fail on one name. */
function accessor(failOn?: string): { tools: ToolsAccessor; live: Set<string> } {
  const live = new Set<string>();
  return {
    live,
    tools: {
      register(spec) {
        if (spec.name === failOn) throw new Error(`cannot register ${spec.name}`);
        live.add(spec.name);
        return () => {
          live.delete(spec.name);
        };
      },
      registerHandler: () => () => undefined,
    },
  };
}

describe('toNativeToolSpec', () => {
  it('names the tool by its id and carries its description', () => {
    const spec = specOf('linear_lookup');
    assert.equal(spec.name, 'linear_lookup');
    assert.match(spec.description, /^List Linear records by name/);
  });

  it('derives an object schema with the required fields and their descriptions', () => {
    const spec = specOf('linear_lookup');
    assert.equal(spec.input_schema.type, 'object');
    assert.deepEqual(spec.input_schema.required, ['kind']);
    assert.deepEqual(property(spec, 'kind')['enum'], ['teams', 'states', 'users', 'labels', 'projects', 'cycles']);
    assert.match(String(property(spec, 'teamKey')['description']), /Defaults to the team configured/);
  });

  it('gives the write tools the flat write schema, with the write wording for assignee', () => {
    for (const [id, mode] of [
      ['linear_prepare_write', 'confirm'],
      ['linear_write', 'direct'],
    ] as const) {
      const spec = specOf(id, mode);
      assert.deepEqual(spec.input_schema.required, ['kind']);
      assert.deepEqual(property(spec, 'kind')['enum'], ['create_issue', 'update_issue', 'add_comment']);
      assert.match(String(property(spec, 'assignee')['description']), /'none' to clear the assignee/);
      assert.equal(property(spec, 'labels')['type'], 'array');
    }
  });

  it('gives the commit tool an empty object schema', () => {
    const spec = specOf('linear_commit_write');
    assert.deepEqual(spec.input_schema, { type: 'object', properties: {} });
  });

  it('keeps every key a model-facing spec may carry and no other', () => {
    for (const tool of toolkitOf().tools) {
      const spec = toNativeToolSpec(tool);
      assert.deepEqual(Object.keys(spec).sort(), ['description', 'input_schema', 'name']);
    }
  });

  it('refuses an input schema that is not an object', () => {
    const odd: ToolDescriptor<unknown, unknown> = {
      id: 'odd',
      description: 'x',
      input: z.string(),
      run: async () => 'x',
    };
    assert.throws(() => toNativeToolSpec(odd), /the input schema must be a z\.object/);
  });
});

describe('registerToolkit', () => {
  it('registers every tool and disposes all of them at once', () => {
    const { tools, live } = accessor();
    const dispose = registerToolkit(tools, toolkitOf());
    assert.equal(live.size, 5);
    dispose();
    assert.equal(live.size, 0);
  });

  it('leaves nothing registered when one tool fails to register', () => {
    const { tools, live } = accessor('linear_lookup');
    assert.throws(() => registerToolkit(tools, toolkitOf()), /cannot register linear_lookup/);
    assert.equal(live.size, 0);
  });
});
