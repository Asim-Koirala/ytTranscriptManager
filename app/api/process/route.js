import { NextResponse } from 'next/server';
import { JobManager } from '@/lib/jobManager';

export async function POST(request) {
  try {
    const body = await request.json();
    const source = body.source === 'local' ? 'local' : 'youtube';
    const input = (body.input ?? body.url ?? '').trim();
    const apiKey = (body.apiKey ?? '').trim();
    const stages = {
      split: !!body.stages?.split,
      transcribe: !!body.stages?.transcribe,
    };
    const chunkDuration = Number(body.chunkDuration) || 600;
    const useBatch = !!body.useBatch;

    if (!input) {
      return NextResponse.json(
        { error: source === 'local' ? 'A local file or folder path is required.' : 'A YouTube URL is required.' },
        { status: 400 }
      );
    }

    // For local input, at least one stage must be selected (download is only for YouTube).
    if (source === 'local' && !stages.split && !stages.transcribe) {
      return NextResponse.json(
        { error: 'Select at least one action (Split and/or Transcribe) for local files.' },
        { status: 400 }
      );
    }

    if (stages.transcribe && !apiKey) {
      return NextResponse.json(
        { error: 'A Gemini API key is required to transcribe.' },
        { status: 400 }
      );
    }

    const jobId = JobManager.createJob({ source, input, apiKey, stages, chunkDuration, useBatch });

    console.log(`[API Process] Job ${jobId} started (source=${source}, split=${stages.split}, transcribe=${stages.transcribe}, chunk=${chunkDuration}s, batch=${useBatch})`);
    return NextResponse.json({ jobId });
  } catch (err) {
    console.error('[API Process] Error starting job:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
