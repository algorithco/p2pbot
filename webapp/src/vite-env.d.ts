/// <reference types="vite/client" />

// Legacy vanilla-JS bundle (src/legacy/*.js) has no types; imported for side
// effects only. Narrow the wildcard as legacy files gain TS declarations.
declare module '*.js';
