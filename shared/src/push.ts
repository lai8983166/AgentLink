import { z } from "zod";

export const PushSubscriptionInput = z.object({
  endpoint: z.string().url().max(4096),
  keys: z.object({ p256dh: z.string().regex(/^[\w-]+$/).min(80).max(100), auth: z.string().regex(/^[\w-]+$/).min(20).max(30) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
export const PushDeviceStatus = z.object({
  id: z.string(),
  lastAcceptedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  pending: z.number(),
});
export type PushDeviceStatus = z.infer<typeof PushDeviceStatus>;
export interface PushConfigResponse { publicKey: string; device: PushDeviceStatus | null }
