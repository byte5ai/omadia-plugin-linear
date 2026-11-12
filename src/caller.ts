/**
 * The caller: which conversation a tool call belongs to, and which turn of it.
 *
 * A tool gets its input and nothing else as an argument. Who is asking comes
 * from the host's turn context, a service the host publishes as the capability
 * `turnContext@1` and which answers, for the call in flight, with the turn the
 * call was made in. The write gate is built on the two facts it holds:
 *
 *   - the **conversation**, so a prepared write is found again when the user
 *     says yes, without a handle that would have to travel through two models
 *     and the user's screen to get back here;
 *   - the **turn**, so a commit made in the turn that prepared is told apart
 *     from one made after the user has answered.
 *
 * The host's session scope is not a conversation key on its own: unscoped HTTP
 * callers all share one literal value. So the key is the agent, the user and
 * the session scope together.
 */

/** The part of the host's turn context this package reads. Declared here
 *  because the service is the host's own object and `@omadia/plugin-api`
 *  exports no type for it; every value is checked before it is used. */
export interface TurnContextService {
  current(): TurnSnapshot | undefined;
}

interface TurnSnapshot {
  readonly turnId?: unknown;
  readonly sessionScope?: unknown;
  readonly userId?: unknown;
  readonly agentSlug?: unknown;
}

export interface Caller {
  /** Opaque key of the conversation. Compared, never shown. */
  readonly conversation: string;
  /** Id of the turn the call is made in. A new one for every user message. */
  readonly turn: string;
}

/** Answers for the call in flight; `undefined` when the call belongs to no
 *  conversation that will have a next turn. */
export type CallerReader = () => Caller | undefined;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A reader over the host's turn context.
 *
 * `undefined` is the answer in four cases, all of which mean the same to a
 * prepared write — no later turn could confirm it: the host publishes no turn
 * context; the call runs outside a turn; the turn has no session scope (a
 * scheduled routine, a tool called by another plugin); or the session scope is
 * the turn's own id, which is what the host substitutes when a channel names
 * no conversation.
 */
export function createCallerReader(service: TurnContextService | undefined): CallerReader {
  return () => {
    if (service === undefined || typeof service.current !== 'function') return undefined;
    let snapshot: TurnSnapshot | undefined;
    try {
      snapshot = service.current();
    } catch {
      return undefined;
    }
    const turn = text(snapshot?.turnId);
    const session = text(snapshot?.sessionScope);
    if (turn === undefined || session === undefined || session === turn) return undefined;
    return {
      conversation: JSON.stringify([
        text(snapshot?.agentSlug) ?? null,
        text(snapshot?.userId) ?? null,
        session,
      ]),
      turn,
    };
  };
}
