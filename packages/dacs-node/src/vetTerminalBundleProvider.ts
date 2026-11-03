import {
  attestationBundleHash,
  type DurableTerminalBundleProvider,
  type TerminalBundleAnchorPublication,
} from "@kynesyslabs/dacs";
import type {
  DacsBundleRoleV1,
  DacsDemosBundlePublicationV1,
} from "./demosBundlePublication.js";

/**
 * The durable terminal-bundle provider for one role's Vet terminal over its
 * Demos publication. Internal to the Vet terminal runtime, which supplies the
 * plan-conflict fences; a separate module only so its read classification
 * can be tested over a stub publication.
 *
 * A read that throws is unanswered (`indeterminate`); only a read that answers
 * with a different bundle, or a role this node does not hold, is `rejected`.
 */
export function createVetTerminalBundleProvider(input: Readonly<{
  role: DacsBundleRoleV1;
  publication: Pick<
    DacsDemosBundlePublicationV1,
    | "resolveRoleBundle"
    | "submitRoleBundle"
    | "verifyBundleAnchorReceipt"
    | "resolveBundleBinding"
    | "publishRoleBundleBinding"
    | "verifyBundleBinding"
  >;
  assertNoPlanConflict: () => Promise<void>;
  conflictFenced: <T>(callback: () => Promise<T> | T) => Promise<T>;
  refuse: (reason: string) => Error;
}>): Readonly<DurableTerminalBundleProvider> {
  const { role, publication, assertNoPlanConflict, conflictFenced, refuse } = input;
  const verify = (
    result: "valid" | "invalid" | "indeterminate" | "error",
    invalidReason: string,
    indeterminateReason: string,
  ) => result === "valid"
    ? Object.freeze({ disposition: "valid" as const })
    : result === "invalid"
      ? Object.freeze({ disposition: "invalid" as const, reason: invalidReason })
      : Object.freeze({
          disposition: "indeterminate" as const,
          reason: indeterminateReason,
        });
  const provider: DurableTerminalBundleProvider = {
    async resolveOwnBundle(input) {
      await assertNoPlanConflict();
      if (input.role !== role) {
        return { disposition: "rejected" as const,
          reason: "vet-terminal-bundle-role-mismatch" };
      }
      try {
        const anchored = await publication.resolveRoleBundle(role);
        if (anchored === null) {
          return { disposition: "authoritatively-absent" as const,
            reason: "vet-terminal-bundle-absent" };
        }
        if (anchored.anchorReceipt.state !== "finalized") {
          return { disposition: "indeterminate" as const,
            reason: "vet-terminal-bundle-finality-pending" };
        }
        const bundleContentHash = attestationBundleHash(anchored.bundle);
        if (anchored.anchorReceipt.logicalAddress !== input.logicalAddress ||
            bundleContentHash !== input.bundleContentHash) {
          return { disposition: "rejected" as const,
            reason: "vet-terminal-bundle-conflict" };
        }
        const value: TerminalBundleAnchorPublication = {
          role,
          logicalAddress: input.logicalAddress,
          nativeAddress: anchored.nativeAddress,
          bundleContentHash,
          bundle: anchored.bundle,
          anchorReceipt: anchored.anchorReceipt,
          ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
        };
        return { disposition: "present" as const, value: Object.freeze(value) };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "vet-terminal-bundle-resolution-unavailable" };
      }
    },
    async submitOwnBundle(input) {
      if (input.role !== role) throw refuse("vet-terminal-bundle-role-mismatch");
      await conflictFenced(() =>
        publication.submitRoleBundle(role, input.logicalAddress, input.bundle));
    },
    async verifyOwnBundlePublication(input) {
      if (input.role !== role) {
        return { disposition: "invalid" as const,
          reason: "vet-terminal-bundle-role-mismatch" };
      }
      return verify(
        await publication.verifyBundleAnchorReceipt({
          bundle: input.bundle,
          nativeAddress: input.nativeAddress,
          anchorReceipt: input.anchorReceipt,
          ...(input.anchorTx === undefined ? {} : { anchorTx: input.anchorTx }),
        }),
        "vet-terminal-bundle-publication-invalid",
        "vet-terminal-bundle-publication-indeterminate",
      );
    },
    async resolveOwnBundleBinding(input) {
      await assertNoPlanConflict();
      if (input.role !== role) {
        return { disposition: "rejected" as const,
          reason: "vet-terminal-binding-role-mismatch" };
      }
      const resolved = await publication.resolveBundleBinding(
        input.logicalAddress,
        input.signer,
      );
      return resolved.disposition === "present"
        ? { disposition: "present" as const, value: resolved.binding }
        : resolved.disposition === "absent"
          ? { disposition: "authoritatively-absent" as const,
              reason: "vet-terminal-binding-absent" }
          : resolved;
    },
    async publishOwnBundleBinding(binding) {
      const result = await conflictFenced(() =>
        publication.publishRoleBundleBinding(role, binding));
      if (result.disposition !== "published") throw refuse(result.reason);
    },
    async verifyOwnBundleBinding(binding) {
      return verify(
        await publication.verifyBundleBinding(binding),
        "vet-terminal-binding-invalid",
        "vet-terminal-binding-indeterminate",
      );
    },
  };
  return Object.freeze(provider);
}
