/**
 * The role prompts of the brain, by role and decision. The port wrapper
 * pairs each prompt with the decision's schema and the user message.
 */

import { ACCEPTANCE_ANALYST_PROMPTS } from './acceptance-analyst';
import { ARCHITECT_PROMPTS } from './architect';
import { CRITIC_PROMPTS } from './critic';

/** Every system prompt, keyed by role and then by decision. */
export const ROLE_PROMPTS = {
  architect: ARCHITECT_PROMPTS,
  acceptance_analyst: ACCEPTANCE_ANALYST_PROMPTS,
  critic: CRITIC_PROMPTS,
} as const;
