import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { JobManager } from '@/lib/jobManager';

const execFileAsync = promisify(execFile);

export async function POST(request) {
  try {
    const body = await request.json();
    const source = body.source === 'local' ? 'local' : 'youtube';
    const input = (body.input ?? body.url ?? '').trim();
    const stages = { split: !!body.stages?.split, transcribe: !!body.stages?.transcribe };

    if (!input) {
      return NextResponse.json(
        { error: source === 'local' ? 'A local file or folder path is required.' : 'A URL is required.' },
        { status: 400 }
      );
    }

    // ---- Local preview: show the recordings/items that would be processed ----
    if (source === 'local') {
      try {
        // Preview uses transcribe-style grouping by default so nested chunk
        // folders are visible; split mode lists full recordings instead.
        const previewStages = stages.split && !stages.transcribe ? { split: true } : { split: false, transcribe: true };
        const { items, baseLabel } = JobManager.discoverLocalItems(input, previewStages);
        if (items.length === 0) {
          return NextResponse.json({ error: 'No .mp3 files found at that path.' }, { status: 404 });
        }
        return NextResponse.json({
          title: baseLabel,
          isPlaylist: items.length > 1,
          source: 'local',
          videos: items.map((it, idx) => ({
            id: `local_${idx}`,
            title: it.title,
            url: it.localPath || it.dir || '',
            duration: 0,
            chunkCount: it.files ? it.files.length : 0,
          })),
        });
      } catch (err) {
        return NextResponse.json({ error: `Could not read local path: ${err.message}` }, { status: 400 });
      }
    }

    // ---- YouTube preview ----
    console.log(`[API Playlist] Fetching metadata for URL: ${input}`);
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-cache-dir',
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      '--youtube-skip-dash-manifest',
      '--ignore-errors',
      '--referer', 'https://www.youtube.com/',
      input,
    ], { maxBuffer: 15 * 1024 * 1024 });

    if (!stdout || !stdout.trim()) {
      return NextResponse.json({ error: 'Failed to retrieve playlist details (empty response)' }, { status: 500 });
    }

    const info = JSON.parse(stdout);
    let videos = [];
    let title = 'Single Video';
    let isPlaylist = false;

    if (info._type === 'playlist') {
      isPlaylist = true;
      title = info.title || 'Playlist';
      videos = (info.entries || [])
        .filter(entry => entry && entry.title)
        .map(entry => ({
          id: entry.id,
          title: entry.title,
          url: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
          duration: entry.duration || 0,
        }));
    } else {
      title = info.title || 'Video';
      videos = [{
        id: info.id || 'single_video',
        title: info.title,
        url: info.webpage_url || input,
        duration: info.duration || 0,
      }];
    }

    return NextResponse.json({ title, videos, isPlaylist, source: 'youtube' });
  } catch (err) {
    console.error('[API Playlist] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
