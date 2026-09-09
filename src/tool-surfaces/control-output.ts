import * as z from "zod/v4";

const text=z.string();
const count=z.number().int().nonnegative();
const error=z.object({code:text,message:text,retryable:z.boolean().optional()}).passthrough();
const usage=z.object({inputTokens:count.optional(),outputTokens:count.optional(),totalTokens:count.optional(),cachedInputTokens:count.optional(),reasoningOutputTokens:count.optional(),cacheWriteInputTokens:count.optional()}).passthrough();
const evidence=z.object({label:text,reference:text,outcome:z.enum(["passed","failed","not_run"])});
const agent=z.object({id:text,status:z.enum(["queued","running","completed","failed","stopped"]),target:text.optional(),response:text.optional(),error:error.optional(),workRunId:text.optional(),revision:text.optional(),responseAvailable:z.boolean().optional(),acceptanceStatus:text.optional(),
  progress:z.object({phase:text,lastActivityAt:text.nullable(),elapsedMs:z.number().nullable(),runtimeMs:z.number().nullable(),queueMs:z.number().nullable(),activityAgeMs:z.number().nullable(),waitingReason:text.nullable(),ownerScope:z.object({workspaceId:text,agentId:text})}).passthrough().optional(),
}).passthrough();
const agentList=z.object({agents:z.array(agent),policy:z.object({maxConcurrentAgents:count,readersPerCheckout:count,writersPerCheckout:count,queueWaitMs:count,maxNewSessionsPerWorkItem:count,sharedResources:z.array(text)}).passthrough()});
const claims=z.object({coordinationEnabled:z.boolean(),claims:z.array(z.object({id:text,kind:text,access:text,state:text,ownerPid:z.number(),resources:z.array(text),agentId:text.optional(),acquiredAt:text.optional(),recovery:text}).passthrough())});
const agentUsage=z.object({status:z.enum(["observed","unknown"]),provider:text.nullable(),scope:z.literal("thread_cumulative"),hasMore:z.boolean(),
  threads:z.array(z.object({threadId:text,totals:usage,observedAt:text})),
  observations:z.array(z.object({turnId:text,threadId:text,cumulative:usage,growth:usage.nullable(),basis:text,lastRequest:usage.nullable(),observedAt:text,providerVersion:text.nullable()}).passthrough()),note:text,
});
const receipt=z.object({workItemId:text,workRunId:text,projectId:text,title:text,executionStatus:text,acceptanceStatus:text,usageStatus:z.enum(["not_used","unavailable","partial","complete"]),codexUsage:usage.nullable(),
  missingExecutions:count,executions:count,pendingExecutions:count,codexThreads:count,codexThreadsCreated:count,codexThreadsReused:count,receiptRevision:count,accountingScope:text,
  evidence:z.array(evidence),origin:z.object({entryPoint:text,evidence:text}).passthrough(),finishedAt:text.nullable(),note:text,
}).passthrough();
const snapshot=z.object({schema:z.literal("devspace.work-snapshot"),version:z.literal(1),workRunId:text,revision:text,unchanged:z.boolean(),executionStatus:text,acceptanceStatus:text,operationCount:count,executionCount:count,
  latestDelivery:z.object({operationId:text,verifiedAt:text,receipt:z.object({schema:text,version:z.number(),sourceHash:text,status:text,sources:z.array(z.object({path:text,sha256:text})),artifacts:z.array(z.object({path:text,sha256:text}))})}).nullable(),
  latestVerifiedDelivery:z.object({operationId:text,verifiedAt:text,receipt:z.object({schema:text,version:z.number(),sourceHash:text,status:text,sources:z.array(z.object({path:text,sha256:text})),artifacts:z.array(z.object({path:text,sha256:text}))})}).nullable(),
  deliveryCompatibility:text,verificationBasis:text,nextAction:text,
}).passthrough();
const operation=z.object({id:text,kind:text,label:text,status:text,evidence:text,created_at:text,finished_at:text.nullable()}).passthrough();
const turn=z.object({executionId:text,agentId:text,status:text,usageStatus:text,codexUsage:usage.nullable()}).passthrough();
const history=z.object({workRunId:text,receiptRevision:count,operations:z.array(operation),turns:z.array(turn),nextCursor:text.nullable(),consistency:text}).passthrough();
const workList=z.object({entries:z.array(receipt),nextOffset:z.number().nullable()});
const recorded=z.union([z.object({operationId:text,receipt}),z.object({operationId:text,snapshot})]);

export function controlOutputShape(name: string, actions: readonly string[]): z.ZodRawShape {
  const data=name.startsWith("agent_")
    ? z.union([agent,agentList,claims,agentUsage,error])
    : z.union([receipt,snapshot,history,workList,recorded,z.array(z.never()),error]);
  return {action:z.enum(actions as [string,...string[]]),data:data.describe("Structured action result. Text content retains the legacy JSON representation.")};
}
