/**
 * "How we checked" -- a certificate, worded the way a player can read it.
 *
 * Every line here comes from a real field of a real `Certificate`. Nothing is
 * guessed and nothing is hardcoded per mystery: a positive claim requires
 * `proven` as well as `ok`/`necessary`, and a search that hit its state cap
 * reads "not fully checked" rather than a false negative.
 */
import type { Certificate, RoleId } from "./validator.ts";
import { ROLE_LABEL } from "./presentation.ts";

export type CheckState = "yes" | "no" | "unknown";

export interface SolvabilityLine {
  /** "yes": a way to finish, proven. "no": proven unreachable. "unknown": capped search. */
  state: CheckState;
  statesExplored: number;
}

export interface RoleCheckLine {
  role: RoleId;
  label: string;
  /** "yes": this role is proven necessary. "no": proven NOT necessary (any more). "unknown": capped. */
  state: CheckState;
  statesExplored: number;
  evidence: string;
}

export interface CertificateView {
  /** The full `certificate.ok`, including accessibility and meaningfulness. */
  ok: boolean;
  solvable: SolvabilityLine;
  roles: RoleCheckLine[];
  /** Words for accessibility/meaningfulness problems, when the certificate does not hold for a reason no role line names. */
  caveats: string[];
  /** The certificate's own digest -- identifies this certificate, not an external authority. */
  hash: string;
}

/** "8 puzzle states checked." for the solvability line. */
export function solvableEvidence(n: number): string {
  return n === 1 ? "1 puzzle state checked." : `${n} puzzle states checked.`;
}

/** "The only reachable puzzle state checked." / "All 5 reachable puzzle states checked." */
export function roleEvidence(n: number): string {
  return n === 1
    ? "The only reachable puzzle state checked."
    : `All ${n} reachable puzzle states checked.`;
}

export function presentCertificate(certificate: Certificate): CertificateView {
  const solvable: SolvabilityLine = {
    state: certificate.solvable.ok && certificate.solvable.proven
      ? "yes"
      : certificate.solvable.truncated || !certificate.solvable.proven
        ? "unknown"
        : "no",
    statesExplored: certificate.solvable.statesExplored,
  };

  const roles: RoleCheckLine[] = Object.entries(certificate.necessity).map(([role, proof]) => {
    const state: CheckState = !proof.proven
      ? "unknown"
      : proof.necessary
        ? "yes"
        : "no";
    return {
      role: role as RoleId,
      label: ROLE_LABEL[role] ?? role,
      state,
      statesExplored: proof.statesExplored,
      evidence: state === "unknown" ? "The check reached its limit here." : roleEvidence(proof.statesExplored),
    };
  });

  const caveats: string[] = [];
  if (!certificate.accessibility.ok) {
    for (const violation of certificate.accessibility.violations) caveats.push(violation.detail);
  }
  for (const [role, proof] of Object.entries(certificate.meaningful)) {
    if (!proof.meaningful) caveats.push(`${ROLE_LABEL[role] ?? role}: ${proof.reason}`);
  }

  return { ok: certificate.ok, solvable, roles, caveats, hash: certificate.hash };
}

/**
 * What the TV says instead of a positive claim while its own connection is
 * down. It is not a claim in either direction: everything the screen knows
 * about the room arrived over that socket, so with the socket down the screen
 * is reading out the last thing it heard, and the TV has no standing to say
 * what the room can do until it hears from it again.
 */
export const RECONNECTING_LINE = "Reconnecting…";

/**
 * The player-facing headline for "how we checked", derived from the same
 * booleans as `certificate.ok` -- never shown unless the whole certificate,
 * accessibility and meaningfulness included, actually holds.
 */
/**
 * `waitingFor`: labels of any role currently held (disconnected) whose proof
 * this certificate counts on. `vacantFor`: labels of any role that is not
 * merely held but genuinely empty -- its hold expired, or its player let it
 * go. The proof itself is never wrong about either kind of role -- the lines
 * below still read proven -- but a screen must not tell the room "you can
 * finish together" while one of them is not actually there to finish it, and
 * the two need different instructions: a held seat is coming back on its
 * own, a vacant one needs someone to join it.
 */
/**
 * The one gate every positive claim in this app passes through, on the TV
 * and nowhere else: a certificate that holds is not enough on its own --
 * every role it counts on has to be both taken and connected, right now,
 * AND the TV has to be in the room to know it. Nothing in
 * `screens.tsx` or `app.tsx` renders "you can finish together", "you did
 * that together", or the still-needs-N-roles line without calling this
 * first; a `false` here means render the waiting/vacant copy below instead.
 *
 * `relayOpen` is required, and it is the one argument a caller cannot leave
 * out. It briefly defaulted to `true`, on the reasoning that a caller with no
 * connection of its own -- a test rendering one screen in isolation -- should
 * not be forced to have an opinion. What that bought was a render site that
 * never had to notice it was missing: the rebuild moment's beat 2 kept the
 * default for a whole round and made the claim through a Wi-Fi blip. The
 * other three arguments have a true default ("nothing is known to be
 * absent"); this one has none, because a socket is either open or it is not,
 * and only the caller knows which.
 */
export function claimHoldsLive(
  ok: boolean,
  waitingFor: readonly string[],
  vacantFor: readonly string[],
  relayOpen: boolean,
): boolean {
  return relayOpen && ok && waitingFor.length === 0 && vacantFor.length === 0;
}

/**
 * "Waiting for C to come back." / "B's seat is empty — someone needs to join as B."
 *
 * Exported so `RebuildMoment` can print the same sentence
 * on the beats that do not already carry it through `HowWeChecked`'s headline
 * -- one sentence, one wording, wherever it lands.
 */
export function waitingOrVacantLine(waitingFor: readonly string[], vacantFor: readonly string[]): string {
  const heldClause =
    waitingFor.length > 0 ? `Waiting for ${joinNames(waitingFor)} to come back.` : "";
  const vacantClause =
    vacantFor.length > 0
      ? `${joinNames(vacantFor)}${vacantFor.length > 1 ? "'" : "'s"} seat${
          vacantFor.length > 1 ? "s are" : " is"
        } empty — someone needs to join as ${joinNames(vacantFor)}.`
      : "";
  return [heldClause, vacantClause].filter((line) => line !== "").join(" ");
}

/**
 * Every positive-vs-waiting line in the app is built from this one shape:
 * the positive text when `claimHoldsLive` says the claim actually holds
 * right now, the held/vacant copy when the underlying fact is ok but a seat
 * is not there to share in it, and the caller's own words for when the fact
 * itself is not ok. `checkedHeadline` and `endingClaimLine` are both just
 * this with their own positive text and their own not-ok fallback.
 */
function positiveClaimLine(
  ok: boolean,
  waitingFor: readonly string[],
  vacantFor: readonly string[],
  positive: string,
  notOk: () => string,
): string {
  if (ok && (waitingFor.length > 0 || vacantFor.length > 0)) {
    return waitingOrVacantLine(waitingFor, vacantFor);
  }
  if (ok) return positive;
  return notOk();
}

export function checkedHeadline(
  view: CertificateView,
  waitingFor: readonly string[] = [],
  vacantFor: readonly string[] = [],
): string {
  return positiveClaimLine(view.ok, waitingFor, vacantFor, "You can finish together.", () => {
    if (view.solvable.state === "unknown") return "We haven't fully checked this yet.";
    if (view.solvable.state === "no") return "There is no proven way to finish from here.";
    return "Not every role is proven necessary here.";
  });
}

/**
 * The ending's own positive claim -- "You did that together." -- through the
 * same gate: the run's final certificate can be `ok` on its own (it is a
 * claim about the puzzle and the play, not about phones), so this is what
 * stops the ending screen from saying it while a seat the room reached the
 * goal without is not actually there any more.
 */
export function endingClaimLine(
  ok: boolean,
  waitingFor: readonly string[],
  vacantFor: readonly string[],
): string {
  return positiveClaimLine(
    ok,
    waitingFor,
    vacantFor,
    "You did that together.",
    () => "the final certificate did not hold — see the badge",
  );
}

/** "C" / "B and C" / "A, B and C" -- plain-English join, never an Oxford comma on two. */
function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const SMALL_NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

/** How many roles this certificate has actually proven necessary -- never a hardcoded mystery role count. */
export function neededRoleCount(view: CertificateView): number {
  return view.roles.filter((r) => r.state === "yes").length;
}

/** "1 role" / "both roles" / "all three roles" -- pluralised on the role count, "both" rather than "all two". */
export function neededRolesPhrase(count: number): string {
  if (count === 1) return "1 role";
  if (count === 2) return "both roles";
  return `all ${SMALL_NUMBER_WORDS[count] ?? count} roles`;
}

/** "the puzzle still needs all three roles" / "the puzzle still needs both roles" -- pluralised on the role count. */
export function stillNeedsLine(view: CertificateView): string {
  return `The puzzle still needs ${neededRolesPhrase(neededRoleCount(view))}.`;
}

export function solvableLabel(state: CheckState): string {
  if (state === "yes") return "With everyone: a way to finish.";
  if (state === "unknown") return "Not fully checked.";
  return "No way to finish.";
}

/** "Without A's role: no way to finish." / "A's role is no longer required." / "Not fully checked." */
export function roleLabel(line: RoleCheckLine): string {
  if (line.state === "yes") return `Without ${line.label}'s role: no way to finish.`;
  if (line.state === "unknown") return "Not fully checked.";
  return "This role is no longer required from here.";
}
