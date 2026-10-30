/**
 * Domain layer: the factory's pure types and rules (spec, plan, task, verdict,
 * trace event, usage). No IO, no SDKs, no imports from any other layer.
 *
 * Today it holds only the product identity the upper layers print; the domain
 * model arrives with the first OpenSpec change that needs it.
 */

/** The product's name and lifecycle stage, as shown by the CLI. */
export const PRODUCT = { name: 'factory-layer', stage: 'under construction' } as const;
