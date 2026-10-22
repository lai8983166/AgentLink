import { z } from "zod";

export const NativeDeviceInput = z.object({ id: z.string().uuid() });
export const NativeAckInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) });
export const NativeDelivery = z.object({
  id: z.string().uuid(),
  expiresAt: z.number(),
  notification: z.object({ title: z.string(), body: z.string(), url: z.string(), tag: z.string() }),
});
export type NativeDelivery = z.infer<typeof NativeDelivery>;
