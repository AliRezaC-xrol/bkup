/** Application version — injected from package.json at BUILD time (next.config.ts). */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";

/** GitHub repository used for update checks (override with GITHUB_REPO env). */
export const GITHUB_REPO = process.env.GITHUB_REPO || "AliRezaC-xrol/bkup";

export const PROJECT_NAME = "bkup";
