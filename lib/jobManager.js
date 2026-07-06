import fs from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);

/**
 * Resolve a static binary path robustly.
 *
 * ffmpeg-static builds its path from `__dirname`. If a
 * bundler (e.g. Turbopack) inlines the module, `__dirname` gets rewritten to a
 * placeholder such as "\ROOT", so the returned path points at a file that does
 * not exist. When that happens we fall back to resolving the binary from the
 * project's real node_modules folder via process.cwd().
 */
function resolveBinaryPath(bundledPath, packageName, exeBaseName) {
  if (bundledPath && !bundledPath.includes('ROOT') && fs.existsSync(bundledPath)) {
    return bundledPath;
  }
  const exe = process.platform === 'win32' ? `${exeBaseName}.exe` : exeBaseName;
  const fallback = path.join(process.cwd(), 'node_modules', packageName, exe);
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  // Last resort: return whatever we had so the error message stays meaningful.
  return bundledPath || fallback;
}

const ffmpegBinary = resolveBinaryPath(ffmpegPath, 'ffmpeg-static', 'ffmpeg');

// Initialize standard job store in global scope to persist across development hot reloads
global.jobsStore = global.jobsStore || {};

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function formatDuration(secs) {
  if (!secs) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class JobManager {
  static get jobs() {
    return global.jobsStore;
  }

  static getJob(id) {
    return this.jobs[id] || null;
  }

  static logToJob(id, message) {
    const job = this.jobs[id];
    if (job) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
      const logLine = `[${timestamp}] ${message}`;
      job.logs.push(logLine);
      console.log(`[Job ${id}] ${message}`);
    }
  }

  /**
   * Create a job.
   * @param {object} options
   * @param {'youtube'|'local'} options.source   Where the audio comes from.
   * @param {string} options.input               YouTube URL, or a local file/folder path.
   * @param {string} [options.apiKey]            Gemini API key (required when transcribing).
   * @param {object} options.stages              { split: boolean, transcribe: boolean }.
   * @param {number} [options.chunkDuration]     Segment length in seconds (default 600).
   */
  static createJob(options = {}) {
    const {
      source = 'youtube',
      input,
      apiKey = '',
      stages = { split: true, transcribe: true },
      chunkDuration = 600,
    } = options;

    const id = 'job_' + Date.now();

    this.jobs[id] = {
      id,
      source,
      input,
      apiKey,
      stages: { split: !!stages.split, transcribe: !!stages.transcribe },
      targetChunkDuration: chunkDuration,
      status: 'initializing',
      playlistTitle: '',
      videos: [],
      logs: [],
      createdAt: new Date().toISOString(),
    };

    this.logToJob(id, `Job created. Source: ${source} | Split: ${stages.split ? 'yes' : 'no'} | Transcribe: ${stages.transcribe ? 'yes' : 'no'}`);
    this.logToJob(id, `Input: ${input}`);

    // Start background processing pipeline asynchronously
    this.runJob(id);

    return id;
  }

  /**
   * List the .mp3 files for a local input path.
   * Returns absolute paths, sorted. Accepts either a single .mp3 file or a
   * directory (top-level .mp3 files only).
   */
  static listLocalMp3s(inputPath) {
    const stat = fs.statSync(inputPath); // throws if the path does not exist
    if (stat.isFile()) {
      if (!inputPath.toLowerCase().endsWith('.mp3')) {
        throw new Error('The selected file is not an .mp3 file.');
      }
      return { files: [path.resolve(inputPath)], baseLabel: path.basename(inputPath, path.extname(inputPath)) };
    }
    if (stat.isDirectory()) {
      const files = fs.readdirSync(inputPath)
        .filter(f => f.toLowerCase().endsWith('.mp3'))
        .sort()
        .map(f => path.resolve(inputPath, f));
      return { files, baseLabel: path.basename(inputPath.replace(/[\\/]+$/, '')) || 'Local Audio' };
    }
    throw new Error('The local path is neither a file nor a directory.');
  }

  /**
   * Build the list of work items for a job from its source + stages.
   * Each item has: { id, title, url?, localPath?, duration, status, progress, chunks, error }
   */
  static async resolveItems(job) {
    const id = job.id;

    if (job.source === 'youtube') {
      job.status = 'fetching_metadata';
      this.logToJob(id, 'Fetching playlist/video metadata using yt-dlp...');

      let info;
      try {
        const { stdout } = await execFileAsync('yt-dlp', [
          '--no-cache-dir',
          '--dump-single-json',
          '--no-warnings',
          '--no-call-home',
          '--no-check-certificates',
          '--youtube-skip-dash-manifest',
          '--ignore-errors',
          '--referer', 'https://www.youtube.com/',
          job.input,
        ], { maxBuffer: 15 * 1024 * 1024 });
        info = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`Failed to retrieve YouTube details: ${err.message}`);
      }
      if (!info) throw new Error('No metadata returned from yt-dlp.');

      let baseLabel;
      let items = [];
      if (info._type === 'playlist') {
        baseLabel = sanitizeFilename(info.title || 'Playlist');
        this.logToJob(id, `Found playlist: "${info.title}" with ${info.entries ? info.entries.length : 0} videos.`);
        items = (info.entries || [])
          .filter(entry => entry && entry.title)
          .map((entry, idx) => ({
            id: entry.id || `video_${idx}`,
            title: entry.title,
            url: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
            duration: entry.duration || 0,
            status: 'queued', progress: 0, chunks: [], error: null,
          }));
      } else {
        baseLabel = sanitizeFilename(info.title || 'Video');
        this.logToJob(id, `Found single video: "${info.title}"`);
        items = [{
          id: info.id || 'video_single',
          title: info.title,
          url: info.webpage_url || job.input,
          duration: info.duration || 0,
          status: 'queued', progress: 0, chunks: [], error: null,
        }];
      }
      return { items, baseLabel };
    }

    // ---- Local source ----
    this.logToJob(id, `Scanning local path for .mp3 files: ${job.input}`);
    const { files, baseLabel } = this.listLocalMp3s(job.input);
    if (files.length === 0) {
      throw new Error('No .mp3 files were found at the given local path.');
    }
    this.logToJob(id, `Found ${files.length} .mp3 file(s).`);

    if (job.stages.split) {
      // Treat each mp3 as an independent full recording to be broken up.
      const items = files.map((f, idx) => ({
        id: `local_${idx}`,
        title: path.basename(f, path.extname(f)),
        localPath: f,
        duration: 0,
        status: 'queued', progress: 0, chunks: [], error: null,
      }));
      return { items, baseLabel: sanitizeFilename(baseLabel) };
    }

    // Transcribe-only on local files: the files ARE the chunks of one recording.
    const items = [{
      id: 'local_group',
      title: sanitizeFilename(baseLabel),
      localPath: null,
      duration: 0,
      status: 'queued', progress: 0, error: null,
      chunks: files.map(f => ({ filename: path.basename(f), path: f, status: 'queued', transcript: '' })),
    }];
    return { items, baseLabel: sanitizeFilename(baseLabel) };
  }

  static async runJob(id) {
    const job = this.jobs[id];
    if (!job) return;
    const { source, stages } = job;

    try {
      // 1. Resolve the list of work items.
      const { items, baseLabel } = await this.resolveItems(job);
      job.playlistTitle = baseLabel;
      job.videos = items;
      if (items.length === 0) throw new Error('Nothing to process.');

      job.status = 'processing';
      this.logToJob(id, `Starting pipeline for ${items.length} item(s)...`);

      const baseOutputDir = path.join(process.cwd(), 'output', baseLabel);
      await fs.promises.mkdir(baseOutputDir, { recursive: true });

      // Only create a Gemini client if we are actually transcribing.
      const ai = stages.transcribe ? new GoogleGenAI({ apiKey: job.apiKey }) : null;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        this.logToJob(id, `--- Item ${i + 1}/${items.length}: "${item.title}" ---`);

        const itemDir = path.join(baseOutputDir, sanitizeFilename(item.title));
        const chunksDir = path.join(itemDir, 'audio_chunks');
        await fs.promises.mkdir(itemDir, { recursive: true });

        try {
          let sourceAudioPath = null; // the full mp3 we split from / transcribe as one

          // ---- STAGE: DOWNLOAD (YouTube only) ----
          if (source === 'youtube') {
            item.status = 'downloading';
            if (i > 0) {
              this.logToJob(id, 'Sleeping for 6 seconds to prevent YouTube rate limits...');
              await new Promise(r => setTimeout(r, 6000));
            }
            this.logToJob(id, `Downloading audio for "${item.title}"...`);
            sourceAudioPath = path.join(itemDir, 'audio.mp3');
            await this.downloadAudio(id, item.url, itemDir, sourceAudioPath);
            this.logToJob(id, `Download complete. Saved to ${sourceAudioPath}`);
          } else if (item.localPath) {
            sourceAudioPath = item.localPath;
          }

          // ---- STAGE: SPLIT ----
          if (stages.split) {
            if (!sourceAudioPath) throw new Error('No source audio available to split.');
            item.status = 'splitting';
            await fs.promises.mkdir(chunksDir, { recursive: true });
            this.logToJob(id, `Splitting audio into ${formatDuration(job.targetChunkDuration)} chunks...`);

            await execFileAsync(ffmpegBinary, [
              '-y',
              '-i', sourceAudioPath,
              '-f', 'segment',
              '-segment_time', String(job.targetChunkDuration),
              '-c', 'copy',
              path.join(chunksDir, 'part_%03d.mp3'),
            ]);

            const chunkFiles = (await fs.promises.readdir(chunksDir))
              .filter(f => f.startsWith('part_') && f.endsWith('.mp3'))
              .sort();
            if (chunkFiles.length === 0) {
              throw new Error('FFmpeg failed to create any audio segment chunks.');
            }
            this.logToJob(id, `Successfully split into ${chunkFiles.length} chunk(s).`);
            item.chunks = chunkFiles.map(filename => ({
              filename,
              path: path.join(chunksDir, filename),
              status: 'queued',
              transcript: '',
            }));
          } else if (source === 'youtube' && stages.transcribe) {
            // Transcribing a downloaded file without splitting: treat the whole
            // track as a single chunk. (For fetch-only we leave chunks empty.)
            item.chunks = [{ filename: 'audio.mp3', path: sourceAudioPath, status: 'queued', transcript: '' }];
          }
          // (local + no split: item.chunks were populated during resolveItems.)

          // ---- If not transcribing, the deliverable is the audio on disk. ----
          if (!stages.transcribe) {
            item.status = 'completed';
            this.logToJob(id, `Done. Audio saved under ${itemDir}`);
            continue;
          }

          // ---- STAGE: TRANSCRIBE ----
          item.status = 'transcribing';
          if (!item.chunks || item.chunks.length === 0) {
            throw new Error('No audio chunks available to transcribe.');
          }
          let fullTranscript = '';

          for (let j = 0; j < item.chunks.length; j++) {
            const chunk = item.chunks[j];
            chunk.status = 'transcribing';
            this.logToJob(id, `Transcribing chunk ${j + 1}/${item.chunks.length}: ${chunk.filename}...`);

            this.logToJob(id, `Uploading ${chunk.filename} to Gemini File API...`);
            let fileUpload;
            try {
              fileUpload = await ai.files.upload({ file: chunk.path, mimeType: 'audio/mp3' });
            } catch (err) {
              throw new Error(`Upload failed for chunk ${chunk.filename}: ${err.message}`);
            }

            this.logToJob(id, `Upload successful (${fileUpload.name}). Waiting for cloud processing...`);
            let fileState = fileUpload;
            let retries = 0;
            while (fileState.state === 'PROCESSING' && retries < 30) {
              await new Promise(r => setTimeout(r, 2000));
              fileState = await ai.files.get({ name: fileUpload.name });
              retries++;
            }
            if (fileState.state !== 'ACTIVE') {
              throw new Error(`File ${chunk.filename} failed in Gemini cloud. State: ${fileState.state}`);
            }

            this.logToJob(id, 'File active. Transcribing with Gemini...');
            const promptInstruction = `
You are an expert bilinguist and transcriber. You are provided with a segment of audio from a lecture/video.
The speaker(s) may speak a mix of English and Nepali.
Please transcribe the audio verbatim and accurately.
- Keep the transcription in the original languages spoken (do not translate Nepali to English or English to Nepali).
- Transcribe Nepali text in Devanagari script (or standard romanized Nepali if that's how it is spoken, but Devanagari is preferred for native Nepali speech).
- Format the transcript cleanly with paragraphs and line breaks.
- If multiple speakers are active, label them if identifiable.
- Do not add any meta-commentary, introductory text, or explanations. Only return the raw verbatim transcript.
`;
            const response = await ai.models.generateContent({
              model: 'gemini-1.5-flash',
              contents: [fileState, promptInstruction],
            });

            const transcriptText = response.text || '';
            chunk.transcript = transcriptText;
            chunk.status = 'completed';
            fullTranscript += `=== PART ${j + 1} (${chunk.filename}) ===\n\n${transcriptText}\n\n`;
            this.logToJob(id, `Completed transcription for chunk ${j + 1}/${item.chunks.length}.`);

            try {
              await ai.files.delete({ name: fileUpload.name });
              this.logToJob(id, `Cleaned up cloud file: ${fileUpload.name}`);
            } catch (err) {
              this.logToJob(id, `Warning: failed to delete cloud file: ${err.message}`);
            }
          }

          const transcriptFilePath = path.join(itemDir, 'transcript.txt');
          await fs.promises.writeFile(transcriptFilePath, fullTranscript, 'utf8');
          this.logToJob(id, `Saved combined transcript to ${transcriptFilePath}`);

          // Clean up only the file WE downloaded, and only when we also split it
          // (the chunks are the useful artefact). Never touch the user's own files.
          if (source === 'youtube' && stages.split) {
            try {
              await fs.promises.unlink(sourceAudioPath);
              this.logToJob(id, `Removed downloaded source audio (chunks are preserved).`);
            } catch { /* ignore */ }
          }

          item.status = 'completed';
          this.logToJob(id, `Successfully completed: "${item.title}"`);
        } catch (err) {
          item.status = 'failed';
          item.error = err.message;
          this.logToJob(id, `ERROR processing "${item.title}": ${err.message}`);
        }
      }

      const failedCount = job.videos.filter(v => v.status === 'failed').length;
      if (failedCount === job.videos.length) {
        job.status = 'failed';
        this.logToJob(id, 'Job finished with errors. All items failed.');
      } else {
        job.status = 'completed';
        this.logToJob(id, `Job completed! ${job.videos.length - failedCount}/${job.videos.length} item(s) succeeded.`);
      }
    } catch (err) {
      job.status = 'failed';
      this.logToJob(id, `CRITICAL JOB ERROR: ${err.message}`);
    }
  }

  /**
   * Download audio as mp3 with retry/backoff. Ensures the result lands at
   * `audioFilePath` (renames if yt-dlp used a different extension).
   */
  static async downloadAudio(id, url, videoDir, audioFilePath) {
    const attempts = 3;
    let ok = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await execFileAsync('yt-dlp', [
          '--no-cache-dir',
          '--no-check-certificates',
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', '5',
          '--ffmpeg-location', ffmpegBinary,
          '-o', path.join(videoDir, 'audio.%(ext)s'),
          '--no-warnings',
          '--referer', 'https://www.youtube.com/',
          url,
        ]);
        ok = true;
        break;
      } catch (dlErr) {
        this.logToJob(id, `Download attempt ${attempt}/${attempts} failed: ${dlErr.message}`);
        if (attempt < attempts) {
          const backoff = attempt * 6000;
          this.logToJob(id, `Waiting ${backoff / 1000} seconds before retry...`);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    if (!ok) throw new Error('Failed to download audio after 3 attempts.');

    if (!fs.existsSync(audioFilePath)) {
      const files = await fs.promises.readdir(videoDir);
      const audioFile = files.find(f => f.startsWith('audio.'));
      if (audioFile) {
        await fs.promises.rename(path.join(videoDir, audioFile), audioFilePath);
      } else {
        throw new Error('Downloaded audio file not found in output path.');
      }
    }
  }
}
