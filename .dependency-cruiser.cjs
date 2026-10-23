/**
 * Module boundaries from the system design (SDD 9.3). `npm run lint:boundaries`
 * fails the build when an import breaks them.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Dependencies point one way; there are no cycles (SDD 9.3 rule 2).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'common-is-leaf',
      severity: 'error',
      comment: 'src/common holds shared helpers with no business rules (SDD 9.3 rule 6).',
      from: { path: '^src/common/' },
      to: { path: '^src/(platform|modules|health)/' },
    },
    {
      name: 'platform-never-depends-on-business',
      severity: 'error',
      comment: 'Platform modules never depend on business modules (SDD 9.3 rule 2).',
      from: { path: '^src/platform/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'modules-use-public-interfaces',
      severity: 'error',
      comment:
        'A module calls another module only through its index.ts (SDD 9.3 rule 1). ' +
        "It never reaches into another module's files or tables.",
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(?!index\\.ts$)',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'platform-uses-public-interfaces',
      severity: 'error',
      comment: 'Business modules call platform modules through their index.ts.',
      from: { path: '^src/modules/' },
      to: { path: '^src/platform/([^/]+)/(?!index\\.ts$)' },
    },
    {
      name: 'no-test-code-in-src',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.spec\\.ts$' },
      to: { path: '^test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js'] },
  },
};
