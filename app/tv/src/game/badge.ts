/**
 * The certificate badge.
 *
 * Every line on the badge comes from a real `certify` call on the real puzzle
 * and the real state. There is no fallback, no cached "it was fine a moment
 * ago", and no partial credit: a refusal produces a refusal badge carrying the
 * validator's own explanation. If the badge ever says ✓, the puzzle really
 * certifies; if it cannot say ✓, it says so on screen.
 */
import type { Certificate, CertifyResult } from "./validator.ts";
import { explainFailure, isCertificate } from "./validator.ts";
import { ROLE_LABEL } from "./presentation.ts";
import type { BadgeLine, BadgeView } from "../../../shared/protocol.ts";

export interface Badge {
  ok: boolean;
  hash: string;
  lines: BadgeLine[];
  /** Set only when the validator refused the input outright. */
  refusal: string | null;
}

/**
 * `isRoleConnected` gates each "X essential" line by whether that role is
 * actually here right now, on top of whether the puzzle needs it. It defaults to "yes, always" -- every existing caller (the
 * in-play badge, the phone wire payload, a repair's own recompiled proof)
 * already gates the room-wide claim it builds on this through
 * `claimHoldsLive` elsewhere, so their behavior is unchanged. The lobby,
 * which shows this proof before anyone has joined at all, is the one caller
 * that passes a real gate (`screens.tsx: Lobby`).
 */
export function badgeFromCertificate(
  certificate: Certificate,
  isRoleConnected: (role: string) => boolean = () => true,
): Badge {
  const lines: BadgeLine[] = [];

  lines.push({
    label: "solvable",
    ok: certificate.solvable.ok && certificate.solvable.proven,
    detail: certificate.solvable.ok
      ? `a witness plan exists (${certificate.solvable.plan.length} steps, ${certificate.solvable.statesExplored} states searched)`
      : certificate.solvable.truncated
        ? "the search hit its state cap, so nothing is proven"
        : "no plan reaches the goal from here",
  });

  // Role by role, in the puzzle's own order: the badge must re-check each role
  // after a repair, not carry a stale answer across the switch.
  let everyoneHere = true;
  for (const [role, proof] of Object.entries(certificate.necessity)) {
    const here = isRoleConnected(role);
    everyoneHere = everyoneHere && here;
    lines.push({
      label: `${ROLE_LABEL[role] ?? role} essential`,
      ok: proof.necessary && proof.proven && here,
      detail: here ? proof.reason : `${ROLE_LABEL[role] ?? role} has not joined yet`,
    });
  }

  const meaningful = Object.entries(certificate.meaningful).filter(([, m]) => !m.meaningful);
  if (!certificate.accessibility.ok || meaningful.length > 0) {
    lines.push({
      label: "everyone can act",
      ok: false,
      detail: [
        ...certificate.accessibility.violations.map((v) => v.detail),
        ...meaningful.map(([role, m]) => `${role}: ${m.reason}`),
      ].join("; "),
    });
  }

  return { ok: certificate.ok && everyoneHere, hash: certificate.hash, lines, refusal: null };
}

/** A badge for a refused certificate: honest, and never ok. */
export function badgeFromRefusal(result: CertifyResult): Badge {
  const reason = explainFailure(result);
  return {
    ok: false,
    hash: "",
    lines: [{ label: "certificate refused", ok: false, detail: reason }],
    refusal: reason,
  };
}

export function badge(result: CertifyResult, isRoleConnected?: (role: string) => boolean): Badge {
  return isCertificate(result) ? badgeFromCertificate(result, isRoleConnected) : badgeFromRefusal(result);
}

export function badgeView(value: Badge): BadgeView {
  return { ok: value.ok, hash: value.hash, lines: value.lines };
}
