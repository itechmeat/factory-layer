/**
 * Architecture policy: cycles, orphans and the layer order of `src/`.
 *
 * Layers, lowest first: domain <- ports <- application <- adapters <- cli.
 * A module may import its own layer or a LOWER one, never a higher one.
 * Type-only imports count: a type that only exists higher up is the same
 * coupling as a value, and `verbatimModuleSyntax` keeps `import type` visible
 * in the source.
 *
 * The rules are generated from `LAYERS`, so the order lives in one place.
 *
 * `bun run check:arch`.
 */

const LAYERS = ['domain', 'ports', 'application', 'adapters', 'cli'];

/**
 * Upward imports allowed as explicit exceptions to the layer policy, keyed by
 * module path under `src/`, valued by the layers it may reach. It is empty and
 * it stays empty: a lower layer that needs something from above gets it
 * injected through a port.
 */
const KNOWN_VIOLATIONS = {};

const layerPath = (layer) => `^src/${layer}/`;
const escaped = (modulePath) => `^src/${modulePath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
const layerOf = (modulePath) => modulePath.split('/')[0];
const exceptionsIn = (layer) => Object.keys(KNOWN_VIOLATIONS).filter((modulePath) => layerOf(modulePath) === layer);

const forbidden = [
  {
    name: 'no-circular',
    severity: 'error',
    comment: 'A cycle between modules is a design error: neither end can be read, tested or replaced alone.',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-orphans',
    severity: 'error',
    comment: 'A module nothing imports and that imports nothing is either dead or an entry point that should be declared as one.',
    from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', '\\.(json|md)$', '\\.test\\.ts$'] },
    to: {},
  },
  {
    name: 'src-outside-layers',
    severity: 'error',
    comment: 'Every module under src/ belongs to exactly one layer directory.',
    from: { path: '^src/', pathNot: LAYERS.map(layerPath) },
    to: {},
  },
];

for (let index = 0; index < LAYERS.length; index += 1) {
  const layer = LAYERS[index];
  const above = LAYERS.slice(index + 1);
  if (above.length === 0) continue;
  forbidden.push({
    name: `layer-${layer}`,
    severity: 'error',
    comment: `${layer} may import its own layer or a lower one, never ${above.join('/')}.`,
    from: { path: layerPath(layer), pathNot: exceptionsIn(layer).map(escaped) },
    to: { path: above.map(layerPath) },
  });
}

for (const [modulePath, allowed] of Object.entries(KNOWN_VIOLATIONS)) {
  const layer = layerOf(modulePath);
  const above = LAYERS.slice(LAYERS.indexOf(layer) + 1).filter((other) => !allowed.includes(other));
  if (above.length === 0) continue;
  forbidden.push({
    name: `layer-${layer}-exception`,
    severity: 'error',
    comment: `${modulePath} is excused for ${allowed.join('/')}; it may still not import ${above.join('/')}.`,
    from: { path: escaped(modulePath) },
    to: { path: above.map(layerPath) },
  });
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden,
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    // dependency-cruiser 18.7 refuses `typescript@>=7` (the compiler API it
    // needs is not published by TS 7.0). `@swc/core` parses the same
    // TypeScript and keeps `import type` in the AST, which this policy has to
    // see. Revisit when dependency-cruiser supports TS 7.
    parser: 'swc',
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'types'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
