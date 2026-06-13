import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  target: z.string().min(1),
  severity: SeveritySchema,
  title: z.string().min(1),
  description: z.string().optional(),
  evidence: z.string().optional(),
  ts: z.number().int().nonnegative(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
