import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { JobManager } from '@/lib/jobManager';

const execFileAsync = promisify(execFile);

export async function POST(request) {
  try {
    const body = await request.json();
    const source = body.source === 'local' ? 'local' : 'youtube';
    const input = (body.input ?? body.url ?? '').trim();

    if (!input) {
      return NextResponse.json(
        { error: source === 'local' ? 'A local file or folder path is required.' : 'A URL is required.' },
        { status: 400 }
      );
    }

    // ---- Local preview: list the .mp3 files that would be processed ----
    if (source === 'local') {
      try {
        const { files, baseLabel } = JobManager.listLocalMp3s(input);
        if (files.length === 0) {
          return NextResponse.json({ error: 'No .mp3 files found at that path.' }, { status: 404 });
        }
        return NextResponse.json({
          title: baseLabel,
          isPlaylist: files.length > 1,
          source: 'local',
          videos: files.map((f, idx) => ({
            id: `local_${idx}`,
            title: path.basename(f),
            url: f,
            duration: 0,
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
