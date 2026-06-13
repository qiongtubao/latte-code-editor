/**
 * AI review API — calls latte-tune sidecar via Tauri.
 * Part of latte-rs-model-router integration.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AiReviewResult {
  success: boolean;
  message: string;
}

export async function aiReview(prompt: string): Promise<AiReviewResult> {
  return invoke<AiReviewResult>("ai_review", { prompt });
}
