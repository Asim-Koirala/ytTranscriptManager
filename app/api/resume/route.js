import { NextResponse } from 'next/server';
import { JobManager } from '@/lib/jobManager';

/**
 * Resume any batch transcription jobs that were submitted in a previous run
 * but never collected (e.g. the dev server was stopped mid-poll). The browser
 * sends its saved Gemini API key so the server can query Google; a
 * GEMINI_API_KEY env var is used as a fallback. Returns immediately — each
 * batch is polled/collected in the background.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiKey = (body.apiKey ?? '').trim();
    const result = await JobManager.resumePendingBatches(apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[API Resume] Error resuming batches:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
