import { NextResponse } from 'next/server';
import { JobManager } from '@/lib/jobManager';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      // List all jobs in basic summary form
      const jobsList = Object.values(JobManager.jobs).map(j => ({
        id: j.id,
        playlistUrl: j.playlistUrl,
        playlistTitle: j.playlistTitle,
        status: j.status,
        createdAt: j.createdAt,
        videoCount: j.videos.length
      }));
      return NextResponse.json({ jobs: jobsList });
    }

    const job = JobManager.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    return NextResponse.json(job);
  } catch (err) {
    console.error('[API Status] Error fetching job status:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
