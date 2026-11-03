import { authenticateSessionProfile, faultCategory } from "@kynesyslabs/dacs";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsBuyerPayDemLiveCommerceGraphV1, DacsSellerPayDemLiveCommerceGraphV1 } from "./livePayDemCommerceGraph.js";
import type { DacsBuyerLiveCommerceGraphV1, DacsSellerLiveCommerceGraphV1 } from "./liveCommerceGraph.js";

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

/** Guard every live entry point, including direct router/terminal calls. */
function admitDacsLiveGraph<T extends Readonly<
  DacsBuyerPayDemLiveCommerceGraphV1 | DacsSellerPayDemLiveCommerceGraphV1 |
  DacsBuyerLiveCommerceGraphV1 | DacsSellerLiveCommerceGraphV1
>>(graph: T, context: Readonly<DacsLiveRoleOperationContextV1>): T {
  const admit = (jobId: string) => admitDacsSessionProfile(context, jobId);
  const operationKey = "payDemOperations" in graph ? "payDemOperations" : "operations";
  const originalOperations = "payDemOperations" in graph ? graph.payDemOperations : graph.operations;
  const operations = Object.fromEntries(Object.entries(originalOperations).map(([key, operation]) =>
    [key, async (...args: Parameters<typeof operation>) => {
      await admit((args[0] as { order: { jobId: string } }).order.jobId);
      return operation(...args);
    }]));
  const guardValidator = (validate: T["validatePayload"]): T["validatePayload"] => async (input) => {
    try { await admit(input.jobId); }
    catch (error) {
      const category = faultCategory(error);
      if (category !== "transient" && category !== "substrate") throw error;
      // Throwing here would make envelope authentication call an outage a
      // malformed message (HTTP 400) and permanently park its durable sender.
      return { status: "unavailable", reasonCode: "session-profile-admission-unavailable" };
    }
    return validate(input);
  };
  const validatePayload = guardValidator(graph.validatePayload);
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
    validatePayload: guardValidator(terminal.validatePayload),
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
  return Object.freeze({ ...graph, [operationKey]: Object.freeze(operations), validatePayload,
    handleMessage, router: Object.freeze({ ...graph.router, validatePayload, handleMessage }),
    ...(terminalBundles === undefined ? {} : { terminalBundles }),
  }) as T;
}

export function admitDacsNativeLiveGraph<T extends Readonly<
  DacsBuyerPayDemLiveCommerceGraphV1 | DacsSellerPayDemLiveCommerceGraphV1
>>(graph: T, context: Readonly<DacsLiveRoleOperationContextV1>): T {
  return admitDacsLiveGraph(graph, context);
}

export function admitDacsX402LiveGraph<T extends Readonly<
  DacsBuyerLiveCommerceGraphV1 | DacsSellerLiveCommerceGraphV1
>>(graph: T, context: Readonly<DacsLiveRoleOperationContextV1>): T {
  return admitDacsLiveGraph(graph, context);
}
