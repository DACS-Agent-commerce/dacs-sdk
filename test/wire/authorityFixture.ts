// Test-only source of truth. Production must install independently authenticated
// transport and participant/session readers; no production gate is mocked.
import { types } from "node:util";
import type * as WireModule from "../../src/wire/index.js";

type Options = Omit<WireModule.BindTp1Options, "readAuthority"> & Partial<Pick<WireModule.BindTp1Options, "readAuthority">>;
export const fixtureBinder = (wire: typeof WireModule) => (options: Options): Promise<WireModule.Tp1Binding> => {
  if (!options || typeof options !== "object" || types.isProxy(options)) return wire.bindTp1Profile(options as WireModule.BindTp1Options);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const record = descriptors.record?.value;
  const field = (key: string) => record && typeof record === "object" && !types.isProxy(record) ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined;
  const profile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION,
    chainIdentity: field("chainIdentity"), pinVersion: field("pinVersion") };
  const readAuthority: WireModule.Tp1AuthorityReader = (scope) => ({
    local: { ...scope.local }, chainIdentity: profile.chainIdentity, provenance: "test-only-independent-authority/v1",
    sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile, modules: wire.TESTNET_PROFILE_TP1.tuple })),
  });
  if (!descriptors.readAuthority) descriptors.readAuthority = { value: readAuthority, enumerable: true };
  return wire.bindTp1Profile(Object.create(Object.getPrototypeOf(options), descriptors));
};
