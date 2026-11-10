export type Env = Cloudflare.Env & {
  /** Public origin for OAuth redirect, e.g. https://cerva-crm.<account>.workers.dev */
  APP_URL?: string;
};

export type AccountType = "residential" | "commercial";
export type DealStage = "lead" | "quoted" | "won" | "lost";
