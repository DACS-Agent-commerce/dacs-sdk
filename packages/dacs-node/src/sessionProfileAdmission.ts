import { authenticateSessionProfile } from "@kynesyslabs/dacs";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsBuyerPayDemLiveCommerceGraphV1, DacsSellerPayDemLiveCommerceGraphV1 } from "./livePayDemCommerceGraph.js";

/** Re-admit on every action; a saved successful admission is never authority. */
export async function admitDacsSessionProfile(
  context: Readonly<DacsLiveRoleOperationContextV1>, jobId: string,
): Promise<void> {
  await authenticateSessionProfile(context.authenticateSessionProfile === undefined ? undefined :
    () => context.authenticateSessionProfile!(jobId), {
    jobId,
    buyer: context.role === "buyer" ? context.authority : context.peerAuthority,
    seller: context.role === "seller" ? context.authority : context.peerAuthority,
  });
}

/** Guard every native live entry point, including direct router/terminal calls. */
export function admitDacsNativeLiveGraph<T extends Readonly<
  DacsBuyerPayDemLiveCommerceGraphV1 | DacsSellerPayDemLiveCommerceGraphV1
>>(graph: T, context: Readonly<DacsLiveRoleOperationContextV1>): T {
  const admit = (jobId: string) => admitDacsSessionProfile(context, jobId);
  const operations = Object.fromEntries(Object.entries(graph.payDemOperations).map(([key, operation]) =>
    [key, async (...args: Parameters<typeof operation>) => {
      await admit(args[0].order.jobId);
      return operation(...args);
    }]));
  const validatePayload: T["validatePayload"] = async (input) => {
    await admit(input.jobId);
    return graph.validatePayload(input);
  };
  const handleMessage: T["handleMessage"] = async (message, inbound) => {
    await admit(message.envelope.jobId);
    return graph.handleMessage(message, inbound);
  };
  const terminal = graph.terminalBundles;
  const terminalBundles = terminal === undefined ? undefined : Object.freeze({
    ...terminal,
    transport: Object.freeze(Object.fromEntries(Object.entries(terminal.transport).map(([name, action]) =>
      [name, async (...args: unknown[]) => {
        const input = args[0] as { jobId?: string; identity?: { jobId: string } };
        await admit(input.identity?.jobId ?? input.jobId!);
        return Reflect.apply(action, terminal.transport, args);
      }])) as unknown as typeof terminal.transport),
    validatePayload: async (input: Parameters<typeof terminal.validatePayload>[0]) => {
      await admit(input.jobId); return terminal.validatePayload(input);
    },
    handleMessage: async (...args: Parameters<typeof terminal.handleMessage>) => {
      await admit(args[0].envelope.jobId); return terminal.handleMessage(...args);
    },
    registerLocalTerminal: async (...args: Parameters<typeof terminal.registerLocalTerminal>) => {
      await admit(args[0].jobId); return terminal.registerLocalTerminal(...args);
    },
    registerLocalVetPass: async (...args: Parameters<NonNullable<typeof terminal.registerLocalVetPass>>) => {
      await admit(args[0].jobId); return terminal.registerLocalVetPass?.(...args);
    },
    advanceRegisteredTerminal: async (jobId: string) => {
      await admit(jobId); return terminal.advanceRegisteredTerminal(jobId);
    },
  });
  return Object.freeze({ ...graph, payDemOperations: Object.freeze(operations), validatePayload,
    handleMessage, router: Object.freeze({ ...graph.router, validatePayload, handleMessage }),
    ...(terminalBundles === undefined ? {} : { terminalBundles }),
  }) as T;
}
