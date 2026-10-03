/** Game version from package.json, injected at build time ('dev' if the define is missing). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
