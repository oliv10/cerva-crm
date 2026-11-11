export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  CRM_PASSWORD?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Public origin for OAuth redirect, e.g. https://cerva-crm.<account>.workers.dev */
  APP_URL?: string;
};

export type AccountType = "residential" | "commercial";

export type OpportunityStage =
  | "new_lead"
  | "contact_attempted"
  | "connected"
  | "interested"
  | "walkthrough_scheduled"
  | "walkthrough_completed"
  | "proposal_sent"
  | "follow_up"
  | "verbal_approval"
  | "won"
  | "lost"
  | "nurture";

export const OPPORTUNITY_STAGES: OpportunityStage[] = [
  "new_lead",
  "contact_attempted",
  "connected",
  "interested",
  "walkthrough_scheduled",
  "walkthrough_completed",
  "proposal_sent",
  "follow_up",
  "verbal_approval",
  "won",
  "lost",
  "nurture",
];
