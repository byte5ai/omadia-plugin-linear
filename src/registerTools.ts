import type { NativeToolSpec, ToolsAccessor } from '@omadia/plugin-api';
import { z } from 'zod';

import type { ToolDescriptor, Toolkit } from './toolkit.js';

/**
 * Hands every tool of the toolkit to the kernel with `ctx.tools.register`
 * (spec 2042 §5.10). The kernel offers the tools to the agents the operator
 * granted this plugin to; the calling agent decides when to use them.
 *
 * The input schema is derived from each tool's Zod schema with Zod's own
 * `z.toJSONSchema`, so the model sees exactly what `run` accepts. `run`
 * validates its input itself and answers a mismatch with a refusal, and a
 * result goes back as text: strings verbatim, anything else as JSON, the form
 * in which the kernel's Privacy Shield reads a result as data.
 *
 * Returns one dispose function that unregisters every tool; call it from
 * `close()`. A tool whose schema cannot be registered fails the activation,
 * and the tools registered before it do not stay behind.
 */
export function registerToolkit(tools: ToolsAccessor, toolkit: Toolkit): () => void {
  const disposers: Array<() => void> = [];
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  try {
    for (const tool of toolkit.tools) {
      disposers.push(
        tools.register(toNativeToolSpec(tool), async (raw) => {
          const result = await tool.run(raw);
          return typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
        }),
      );
    }
  } catch (err) {
    disposeAll();
    throw err;
  }
  return disposeAll;
}

/** The kernel's tool spec for one tool: name, description and the JSON schema
 *  of its input, which has to be an object. */
export function toNativeToolSpec(tool: ToolDescriptor<unknown, unknown>): NativeToolSpec {
  const schema = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' });
  if (schema.type !== 'object') {
    throw new Error(`tool '${tool.id}': the input schema must be a z.object(...), got type '${String(schema.type)}'`);
  }
  const required = schema.required ?? [];
  return {
    name: tool.id,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: schema.properties ?? {},
      ...(required.length > 0 ? { required } : {}),
    },
  };
}
