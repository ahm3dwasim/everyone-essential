/**
 * The TV's own connection to the room, and the last thing the relay refused.
 *
 * These are two different facts and they were one variable. `app.tsx` kept a
 * single `status` string: `onStatus` wrote the socket's state into it, and
 * `onRelayError` wrote `relay error: …` into the same place for every refusal.
 * An earlier version then made the claim screens read `status === "open"` for
 * `relayOpen`, which meant a refusal that has nothing to do with the
 * connection -- `malformed`, which the relay sends for a frame it will not
 * forward, and which a perfectly well connected TV keeps receiving -- turned
 * every positive claim on the screen into "Reconnecting…". Nothing set it
 * back: the string is replaced only by the next `onStatus`, and the socket may
 * not change state again for the rest of the session, so the TV stayed
 * "Reconnecting…" for as long as it was left alone.
 *
 * So a refusal is a NOTICE here, kept for the diagnostic line, and it never
 * moves the connection. The connection moves when the socket does, which is
 * the `onStatus` callback and nothing else. Being welcomed into a room again
 * retires the notice -- a `welcome` is the relay's own word that whatever it
 * refused a moment ago is behind us -- and keeps it across a close, so a blip
 * does not erase the only record of why the relay refused something.
 *
 * Both facts live in one value because they are read together, by one caller;
 * what matters is that they are written by different events, which is what
 * this module's two functions make explicit.
 */
import type { ConnectionStatus } from "../../shared/client.ts";

export interface TvConnection {
  /** The socket's own state. The only thing a claim screen may read. */
  status: ConnectionStatus;
  /** The last refusal the relay sent, for the diagnostic line. Never a state. */
  notice: string | null;
}

export const INITIAL_CONNECTION: TvConnection = { status: "connecting", notice: null };

/** The socket changed state. The only writer of `status`. */
export function connectionOnStatus(state: TvConnection, status: ConnectionStatus): TvConnection {
  return { status, notice: status === "open" ? null : state.notice };
}

/**
 * The relay refused something. Deliberately reads `detail` and never `code`:
 * a code decides what the TV DOES about a refusal (`not_the_tv` ends the
 * game), not what the connection IS. A TV that reads the two as one thing is
 * the defect this module exists to make unrepresentable.
 */
export function connectionOnRelayError(
  state: TvConnection,
  error: { code: string; detail: string },
): TvConnection {
  return { ...state, notice: `relay error: ${error.detail}` };
}

/** Whether the TV is in the room right now -- what every claim screen asks. */
export function relayIsOpen(state: TvConnection): boolean {
  return state.status === "open";
}
