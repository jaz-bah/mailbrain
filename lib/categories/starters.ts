import type { CategoryInput } from "@/lib/categories/schema"

/** Starter templates offered when the user has no categories (PRD CAT-5). */
export const STARTER_CATEGORIES: CategoryInput[] = [
  {
    name: "Job Interview",
    description: "Emails related to job interviews.",
    instructions:
      "Identify emails that invite, schedule, confirm, reschedule, or discuss a job interview.",
  },
  {
    name: "Job Offer",
    description: "Employment offers and offer letters.",
    instructions: "Identify emails that extend a job offer, include an offer letter, or negotiate offer terms.",
  },
  {
    name: "Expiry Notice",
    description: "Notices about subscriptions, documents, accounts or services that are expiring.",
    instructions:
      "Identify emails warning that something expires, lapses or needs renewal soon, such as a subscription, domain, card, passport or account.",
  },
  {
    name: "Invoices",
    description: "Invoices, bills and payment receipts.",
    instructions: "Identify emails that contain or link to an invoice, bill, receipt or payment request.",
  },
  {
    name: "Newsletters",
    description: "Newsletters and marketing digests.",
    instructions: "Identify recurring newsletters, digests and promotional mailings.",
  },
]
