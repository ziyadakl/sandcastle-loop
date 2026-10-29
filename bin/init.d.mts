export declare function detectActiveProfile(targetDir: string): "mac-host" | "minimal";
export declare function detectPackageManager(targetDir: string): "pnpm" | "npm" | "yarn";
export declare function registerPnpmPatch(targetDir: string): void;
