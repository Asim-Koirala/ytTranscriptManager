import fs from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';

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

// Gemini models to try for transcription, newest first. If one is unavailable
// for the caller's API version/tier (404 NOT_FOUND), we fall back to the next
// and remember the working one for the rest of the job. All are real,
// audio-capable models — see https://ai.google.dev/gemini-api/docs/models
const MODEL_CANDIDATES = ['gemini-2.5-flash'];

// The transcription instruction sent alongside every audio chunk. Shared by
// both the synchronous (generateContent) and Batch API code paths so the two
// modes always produce identically-formatted transcripts.
const TRANSCRIBE_PROMPT = `
You are an expert bilinguist and transcriber. You are provided with a segment of audio from a lecture/video.
The speaker(s) may speak a mix of English and Nepali.
Please transcribe the audio verbatim and accurately.
- Keep the transcription in the original languages spoken (do not translate Nepali to English or English to Nepali).
- Transcribe Nepali text in Devanagari script (or standard romanized Nepali if that's how it is spoken, but Devanagari is preferred for native Nepali speech).
- Format the transcript cleanly with paragraphs and line breaks.
- If multiple speakers are active, label them if identifiable.
- Do not add any meta-commentary, introductory text, or explanations. Only return the raw verbatim transcript.
`;

// Generation config used for every transcription request (sync and batch).
// - thinkingConfig.thinkingBudget = 0 DISABLES "thinking". On models where
//   thinking is on by default (e.g. gemini-2.5-flash), a long/dense chunk can
//   otherwise spend the entire output budget on thoughts and return an EMPTY
//   transcript with finishReason MAX_TOKENS. Transcription needs no reasoning,
//   so we turn it off — this also makes it faster and cheaper.
// - maxOutputTokens is set high because verbatim transcripts of long chunks are
//   large; 65536 is the output ceiling for the 2.5 flash family.
// - temperature 0 for faithful, low-variance transcription.
const TRANSCRIBE_CONFIG = {
  thinkingConfig: { thinkingBudget: 0 },
  maxOutputTokens: 65536,
  temperature: 0,
};

// Terminal states for a Gemini Batch job (see JobState in @google/genai).
const BATCH_TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);

// Where we persist "pending" batch jobs so they survive a server restart. Each
// file holds enough metadata (batch name, chunk order, output path, uploaded
// file names) to collect the results later. The API key is deliberately NOT
// stored here — it is supplied again on resume (from the browser or the
// GEMINI_API_KEY env var). This directory is gitignored.
const PENDING_BATCH_DIR = path.join(process.cwd(), '.pending-batches');

// Initialize standard job store in global scope to persist across development hot reloads
global.jobsStore = global.jobsStore || {};

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * Decide whether a Gemini/network error is worth retrying. Temporary server
 * conditions (503 UNAVAILABLE / "high demand" / overloaded, 500 INTERNAL,
 * 429 RESOURCE_EXHAUSTED) and low-level connection drops ("fetch failed",
 * ECONNRESET, ETIMEDOUT, socket hang up) are transient. Everything else —
 * 400 bad request, 401/403 auth, 404 NOT_FOUND — is permanent and must
 * surface immediately so we don't loop on a hopeless call.
 */
function isTransientError(err) {
  const status = Number(err && (err.status || (err.error && err.error.code)));
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String((err && err.message) || err).toLowerCase();
  return (
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('high demand') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('internal error') ||
    msg.includes('deadline') ||
    /\b(429|500|502|503|504)\b/.test(msg) ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
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
   * Run an async operation with exponential backoff on transient failures.
   * Non-transient errors (auth, bad request, 404) are thrown on the first try.
   * Backoff grows 5s, 10s, 20s, 40s (capped at 60s) with jitter to avoid
   * hammering an overloaded Gemini endpoint in lockstep.
   */
  static async withRetry(id, label, fn, { attempts = 5, baseDelay = 5000 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isTransientError(err) || attempt === attempts) throw err;
        const backoff = Math.min(baseDelay * 2 ** (attempt - 1), 60000);
        const wait = backoff + Math.floor(backoff * 0.25 * Math.random());
        this.logToJob(
          id,
          `${label} failed (attempt ${attempt}/${attempts}): ${err.message}. Retrying in ${Math.round(wait / 1000)}s...`
        );
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  /**
   * Create a job.
   * @param {object} options
   * @param {'youtube'|'local'} options.source   Where the audio comes from.
   * @param {string} options.input               YouTube URL, or a local file/folder path.
   * @param {string} [options.apiKey]            Gemini API key (required when transcribing).
   * @param {object} options.stages              { split: boolean, transcribe: boolean }.
   * @param {number} [options.chunkDuration]     Segment length in seconds (default 600).
   * @param {boolean} [options.useBatch]         Transcribe via the Gemini Batch API (cheaper, async).
   */
  static createJob(options = {}) {
    const {
      source = 'youtube',
      input,
      apiKey = '',
      stages = { split: true, transcribe: true },
      chunkDuration = 600,
      useBatch = false,
    } = options;

    const id = 'job_' + Date.now();

    this.jobs[id] = {
      id,
      source,
      input,
      apiKey,
      stages: { split: !!stages.split, transcribe: !!stages.transcribe },
      targetChunkDuration: chunkDuration,
      useBatch: !!useBatch,
      status: 'initializing',
      playlistTitle: '',
      videos: [],
      logs: [],
      createdAt: new Date().toISOString(),
    };

    this.logToJob(id, `Job created. Source: ${source} | Split: ${stages.split ? 'yes' : 'no'} | Transcribe: ${stages.transcribe ? 'yes' : 'no'}${stages.transcribe && useBatch ? ' (Batch API)' : ''}`);
    this.logToJob(id, `Input: ${input}`);

    // Start background processing pipeline asynchronously
    this.runJob(id);

    return id;
  }

  /**
   * Discover the work items for a local input path, honouring the selected
   * stages. Handles single files, flat folders of mp3s, and nested tree
   * structures like the app's own output/ layout
   * (<playlist>/<video>/audio_chunks/part_*.mp3).
   *
   * Returns { baseLabel, items }, where each item is:
   *   - split mode:      { title, localPath }            (a full recording to break up)
   *   - transcribe mode: { title, files: [...], dir }    (a recording's existing chunks)
   */
  static discoverLocalItems(inputPath, stages) {
    const stat = fs.statSync(inputPath); // throws if the path does not exist
    const cleanName = (d) => {
      const b = path.basename(d);
      return b.toLowerCase() === 'audio_chunks' ? path.basename(path.dirname(d)) : b;
    };

    // ---- Single file ----
    if (stat.isFile()) {
      if (!inputPath.toLowerCase().endsWith('.mp3')) {
        throw new Error('The selected file is not an .mp3 file.');
      }
      const abs = path.resolve(inputPath);
      const baseLabel = path.basename(inputPath, path.extname(inputPath));
      if (stages.split) {
        return { baseLabel, items: [{ title: baseLabel, localPath: abs }] };
      }
      return { baseLabel, items: [{ title: baseLabel, files: [abs], dir: path.dirname(abs) }] };
    }
    if (!stat.isDirectory()) {
      throw new Error('The local path is neither a file nor a directory.');
    }

    const root = path.resolve(inputPath);
    const baseLabel = path.basename(root.replace(/[\\/]+$/, '')) || 'Local Audio';
    const mp3sIn = (dir) => fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.mp3'))
      .sort()
      .map(f => path.join(dir, f));
    const subdirs = (dir) => fs.readdirSync(dir)
      .map(f => path.join(dir, f))
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });

    // ---- Split mode: gather full recordings, ignoring any audio_chunks folders ----
    if (stages.split) {
      const files = [];
      const walkSplit = (dir) => {
        for (const f of mp3sIn(dir)) files.push(f);
        for (const sub of subdirs(dir)) {
          if (path.basename(sub).toLowerCase() === 'audio_chunks') continue; // don't re-split chunks
          walkSplit(sub);
        }
      };
      walkSplit(root);
      const items = files.map(f => {
        const base = path.basename(f, path.extname(f));
        const title = base.toLowerCase() === 'audio' ? path.basename(path.dirname(f)) : base;
        return { title, localPath: f };
      });
      return { baseLabel, items };
    }

    // ---- Transcribe mode: group existing chunks per recording ----
    const groups = [];
    const walkTranscribe = (dir) => {
      const chunksSub = subdirs(dir).find(s => path.basename(s).toLowerCase() === 'audio_chunks');
      if (chunksSub) {
        const chunkFiles = mp3sIn(chunksSub);
        if (chunkFiles.length > 0) {
          groups.push({ title: cleanName(dir), files: chunkFiles, dir });
          return; // this recording is fully described by its audio_chunks folder
        }
      }
      const direct = mp3sIn(dir);
      if (direct.length > 0) {
        groups.push({ title: cleanName(dir), files: direct, dir });
        return; // treat this folder's mp3s as the chunks of one recording
      }
      for (const sub of subdirs(dir)) walkTranscribe(sub); // descend to find recordings
    };
    walkTranscribe(root);
    return { baseLabel, items: groups };
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
    const { items: discovered, baseLabel } = this.discoverLocalItems(job.input, job.stages);
    if (discovered.length === 0) {
      throw new Error('No .mp3 files were found at the given local path.');
    }

    // Build items with unique, sanitized titles.
    const seen = {};
    const items = discovered.map((it, idx) => {
      let title = sanitizeFilename(it.title) || `item_${idx + 1}`;
      if (seen[title] != null) { seen[title] += 1; title = `${title} (${seen[title]})`; }
      else { seen[title] = 0; }

      const base = { id: `local_${idx}`, title, duration: 0, status: 'queued', progress: 0, error: null };
      if (job.stages.split) {
        return { ...base, localPath: it.localPath, chunks: [] };
      }
      return {
        ...base,
        localPath: null,
        sourceDir: it.dir, // write transcript.txt back into the recording's own folder
        chunks: it.files.map(f => ({ filename: path.basename(f), path: f, status: 'queued', transcript: '' })),
      };
    });

    if (job.stages.split) {
      this.logToJob(id, `Found ${items.length} recording(s) to split.`);
    } else {
      const totalChunks = items.reduce((n, v) => n + v.chunks.length, 0);
      this.logToJob(id, `Found ${items.length} recording(s) with ${totalChunks} existing chunk(s) to transcribe.`);
    }
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

        // Transcribe-only local items write results back into their own source
        // folder (next to the existing chunks); everything else goes under output/.
        const itemDir = item.sourceDir || path.join(baseOutputDir, sanitizeFilename(item.title));
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

          const transcriptFilePath = path.join(itemDir, 'transcript.txt');

          // Two transcription modes:
          //   - Batch API (job.useBatch): submit all of an item's chunks as one
          //     async batch job. ~50% cheaper, at the cost of higher latency.
          //   - Synchronous (default): one generateContent call per chunk.
          const fullTranscript = job.useBatch
            ? await this.transcribeChunksBatch(id, job, ai, item, transcriptFilePath)
            : await this.transcribeChunksSync(id, job, ai, item);

          await fs.promises.writeFile(transcriptFilePath, fullTranscript, 'utf8');
          this.logToJob(id, `Saved combined transcript to ${transcriptFilePath}`);

          // Transcript is safely on disk — clear any pending-batch record so it
          // isn't needlessly re-collected on the next restart.
          if (item._pendingBatchId) {
            this.deletePendingBatch(item._pendingBatchId);
            item._pendingBatchId = null;
          }

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
   * Pull the plain-text transcript out of a Gemini GenerateContentResponse.
   * The synchronous SDK exposes a `.text` getter, but Batch API results arrive
   * as plain JSON objects (no getter), so we fall back to concatenating the
   * text parts of the first candidate.
   */
  static extractText(response) {
    if (!response) return '';
    if (typeof response.text === 'string' && response.text) return response.text;
    // Concatenate the text parts of the first candidate, skipping any "thought"
    // parts (thinking models can emit thought-only parts with no real output).
    const parts = response.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter(p => p && !p.thought && typeof p.text === 'string')
        .map(p => p.text)
        .join('');
    }
    return '';
  }

  /** Why generation stopped (STOP, MAX_TOKENS, SAFETY, ...), for diagnostics. */
  static finishReasonOf(response) {
    return response?.candidates?.[0]?.finishReason || '';
  }

  /**
   * Upload a single chunk to the Gemini File API and wait until it is ACTIVE
   * (i.e. finished cloud-side processing). Returns the active File object.
   */
  static async uploadChunkAndWait(id, ai, chunk) {
    this.logToJob(id, `Uploading ${chunk.filename} to Gemini File API...`);
    let fileUpload;
    try {
      fileUpload = await this.withRetry(id, `Upload ${chunk.filename}`, () =>
        ai.files.upload({ file: chunk.path, mimeType: 'audio/mp3' })
      );
    } catch (err) {
      throw new Error(`Upload failed for chunk ${chunk.filename}: ${err.message}`);
    }

    this.logToJob(id, `Upload successful (${fileUpload.name}). Waiting for cloud processing...`);
    let fileState = fileUpload;
    let retries = 0;
    while (fileState.state === 'PROCESSING' && retries < 30) {
      await new Promise(r => setTimeout(r, 2000));
      fileState = await this.withRetry(id, `Poll ${chunk.filename}`, () =>
        ai.files.get({ name: fileUpload.name })
      );
      retries++;
    }
    if (fileState.state !== 'ACTIVE') {
      throw new Error(`File ${chunk.filename} failed in Gemini cloud. State: ${fileState.state}`);
    }
    // Preserve the upload's resource name for later deletion.
    if (!fileState.name) fileState.name = fileUpload.name;
    return fileState;
  }

  /**
   * Synchronous transcription: one generateContent call per chunk, uploading
   * and cleaning up each file as we go. Returns the combined transcript text.
   */
  static async transcribeChunksSync(id, job, ai, item) {
    let fullTranscript = '';

    for (let j = 0; j < item.chunks.length; j++) {
      const chunk = item.chunks[j];
      chunk.status = 'transcribing';
      this.logToJob(id, `Transcribing chunk ${j + 1}/${item.chunks.length}: ${chunk.filename}...`);

      const fileState = await this.uploadChunkAndWait(id, ai, chunk);

      this.logToJob(id, 'File active. Transcribing with Gemini...');
      const contents = createUserContent([
        createPartFromUri(fileState.uri, fileState.mimeType || 'audio/mp3'),
        TRANSCRIBE_PROMPT,
      ]);

      // Use the already-resolved model, else try candidates until one works.
      let response = null;
      let lastErr = null;
      const candidates = job.resolvedModel ? [job.resolvedModel] : MODEL_CANDIDATES;
      for (const model of candidates) {
        try {
          response = await this.withRetry(id, `Gemini transcription (${model})`, () =>
            ai.models.generateContent({ model, contents, config: TRANSCRIBE_CONFIG })
          );
          if (!job.resolvedModel) {
            job.resolvedModel = model;
            this.logToJob(id, `Using Gemini model: ${model}`);
          }
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e && e.message);
          if (msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('404')) {
            this.logToJob(id, `Model ${model} not available, trying next...`);
            continue;
          }
          throw e; // a real error (rate limit, bad request, etc.)
        }
      }
      if (!response) {
        throw new Error(`No usable Gemini model found. Last error: ${lastErr && lastErr.message}`);
      }

      const transcriptText = this.extractText(response);
      chunk.transcript = transcriptText;
      chunk.status = 'completed';
      if (!transcriptText) {
        const fr = this.finishReasonOf(response) || 'empty response';
        this.logToJob(id, `WARNING: chunk ${j + 1} (${chunk.filename}) returned no transcript (finishReason: ${fr}).`);
        fullTranscript += `=== PART ${j + 1} (${chunk.filename}) ===\n\n[No transcript returned — finishReason: ${fr}]\n\n`;
      } else {
        fullTranscript += `=== PART ${j + 1} (${chunk.filename}) ===\n\n${transcriptText}\n\n`;
      }
      this.logToJob(id, `Completed transcription for chunk ${j + 1}/${item.chunks.length}.`);

      try {
        await ai.files.delete({ name: fileState.name });
        this.logToJob(id, `Cleaned up cloud file: ${fileState.name}`);
      } catch (err) {
        this.logToJob(id, `Warning: failed to delete cloud file: ${err.message}`);
      }
    }

    return fullTranscript;
  }

  // ---- Pending-batch persistence (survives server restarts) ----

  static ensurePendingDir() {
    if (!fs.existsSync(PENDING_BATCH_DIR)) {
      fs.mkdirSync(PENDING_BATCH_DIR, { recursive: true });
    }
    return PENDING_BATCH_DIR;
  }

  static pendingBatchPath(metaId) {
    return path.join(PENDING_BATCH_DIR, `${sanitizeFilename(metaId)}.json`);
  }

  static savePendingBatch(meta) {
    this.ensurePendingDir();
    fs.writeFileSync(this.pendingBatchPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
  }

  static deletePendingBatch(metaId) {
    try { fs.unlinkSync(this.pendingBatchPath(metaId)); } catch { /* already gone */ }
  }

  static listPendingBatches() {
    if (!fs.existsSync(PENDING_BATCH_DIR)) return [];
    return fs.readdirSync(PENDING_BATCH_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(PENDING_BATCH_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(m => m && m.batchName && Array.isArray(m.chunkFilenames) && m.transcriptPath);
  }

  /**
   * Poll a batch job until it reaches a terminal state (or a ~2h safety cap).
   * Returns the last-seen BatchJob. `log(msg)` receives progress lines so both
   * the live path (job logs) and the resume path (console) can report state.
   */
  static async pollBatch(ai, batchName, log) {
    const maxPolls = 480; // ~2h at 15s between polls
    let batchJob = null;
    for (let polls = 0; polls < maxPolls; polls++) {
      try {
        batchJob = await ai.batches.get({ name: batchName });
      } catch (err) {
        if (!isTransientError(err)) throw err;
        log(`Poll error (transient): ${err.message}. Retrying in 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      if (BATCH_TERMINAL_STATES.has(batchJob.state)) return batchJob;
      log(`Batch job state: ${batchJob.state} (poll ${polls + 1}/${maxPolls}).`);
      await new Promise(r => setTimeout(r, 15000));
    }
    return batchJob; // still non-terminal — caller treats as "not yet succeeded"
  }

  /**
   * Turn a succeeded BatchJob's inlined responses into the combined transcript
   * text, in the same order as the original chunks. `onChunk(idx, {status,
   * transcript})` is called per chunk so the live path can update its in-memory
   * chunk objects for the UI; the resume path omits it. `log(msg)` (optional)
   * receives a warning for any chunk that came back empty.
   */
  static buildBatchTranscript(batchJob, chunkFilenames, onChunk, log) {
    const responses = batchJob.dest?.inlinedResponses || [];
    let full = '';
    let empty = 0;
    chunkFilenames.forEach((filename, idx) => {
      const r = responses[idx];
      if (r && r.error) {
        if (onChunk) onChunk(idx, { status: 'failed', transcript: '' });
        full += `=== PART ${idx + 1} (${filename}) ===\n\n[Transcription failed: ${r.error.message}]\n\n`;
        return;
      }
      const text = this.extractText(r && r.response);
      if (!text) {
        empty++;
        const fr = this.finishReasonOf(r && r.response) || 'empty response';
        if (log) log(`WARNING: chunk ${idx + 1} (${filename}) returned no transcript (finishReason: ${fr}).`);
        if (onChunk) onChunk(idx, { status: 'completed', transcript: '' });
        full += `=== PART ${idx + 1} (${filename}) ===\n\n[No transcript returned — finishReason: ${fr}]\n\n`;
        return;
      }
      if (onChunk) onChunk(idx, { status: 'completed', transcript: text });
      full += `=== PART ${idx + 1} (${filename}) ===\n\n${text}\n\n`;
    });
    return { full, responseCount: responses.length, expected: chunkFilenames.length, empty };
  }

  static async deleteUploadedFiles(ai, uploadedNames, log) {
    for (const name of uploadedNames || []) {
      try { await ai.files.delete({ name }); }
      catch (err) { log(`Warning: failed to delete cloud file ${name}: ${err.message}`); }
    }
  }

  /**
   * Batch transcription: upload all of the item's chunks, submit them as a
   * single Gemini Batch job (one inlined request per chunk), persist a pending
   * record to disk, then poll until the job reaches a terminal state and map
   * the inlined responses back onto the chunks in order. ~50% cheaper than the
   * synchronous path but higher latency.
   *
   * If the process is killed mid-poll, the pending record on disk lets
   * resumePendingBatches() collect the results on the next run.
   *
   * Returns the combined transcript text. `transcriptPath` is where the caller
   * will write transcript.txt; it is stored so a resumed run can recreate it.
   */
  static async transcribeChunksBatch(id, job, ai, item, transcriptPath) {
    const model = job.resolvedModel || MODEL_CANDIDATES[0];
    if (!job.resolvedModel) {
      job.resolvedModel = model;
      this.logToJob(id, `Using Gemini Batch API with model: ${model}`);
    }

    // 1. Upload every chunk and wait for it to become ACTIVE.
    const uploaded = []; // { chunk, fileState }
    for (let j = 0; j < item.chunks.length; j++) {
      const chunk = item.chunks[j];
      chunk.status = 'transcribing';
      this.logToJob(id, `Preparing chunk ${j + 1}/${item.chunks.length} for batch: ${chunk.filename}...`);
      const fileState = await this.uploadChunkAndWait(id, ai, chunk);
      uploaded.push({ chunk, fileState });
    }

    // 2. Build one inlined request per chunk. The model is set at batch level.
    //    The same generation config as the sync path (thinking disabled, high
    //    output budget) so batch chunks don't come back empty.
    const inlinedRequests = uploaded.map(({ fileState }) => ({
      contents: createUserContent([
        createPartFromUri(fileState.uri, fileState.mimeType || 'audio/mp3'),
        TRANSCRIBE_PROMPT,
      ]),
      config: TRANSCRIBE_CONFIG,
    }));

    // 3. Submit the batch job.
    this.logToJob(id, `Submitting Gemini batch job for ${inlinedRequests.length} chunk(s)...`);
    const batchJob = await this.withRetry(id, 'Create batch job', () =>
      ai.batches.create({ model, src: inlinedRequests })
    );
    const batchName = batchJob.name;

    // 4. Persist a pending record BEFORE we start waiting, so a restart can
    //    pick the results up. No API key is written to disk.
    const uploadedFiles = uploaded.map(({ fileState }) => fileState.name);
    const meta = {
      id: `${id}__${sanitizeFilename(item.title)}`,
      batchName,
      itemTitle: item.title,
      transcriptPath,
      chunkFilenames: item.chunks.map(c => c.filename),
      uploadedFiles,
      createdAt: new Date().toISOString(),
    };
    this.savePendingBatch(meta);
    item._pendingBatchId = meta.id;
    this.logToJob(id, `Batch job created: ${batchName}. Saved pending record (safe to restart). Waiting for completion...`);

    // 5. Poll until terminal (this is the "live" wait; a restart resumes instead).
    const finalJob = await this.pollBatch(ai, batchName, (m) => this.logToJob(id, m));

    if (!finalJob || finalJob.state !== 'JOB_STATE_SUCCEEDED') {
      await this.deleteUploadedFiles(ai, uploadedFiles, (m) => this.logToJob(id, m));
      this.deletePendingBatch(meta.id);
      item._pendingBatchId = null;
      const reason = finalJob?.error?.message || finalJob?.state || 'timed out waiting';
      throw new Error(`Batch job did not succeed. Final state: ${finalJob?.state}. ${reason}`);
    }

    // 6. Map inlined responses back onto the (live) chunk objects for the UI.
    const { full, responseCount, expected, empty } = this.buildBatchTranscript(
      finalJob,
      meta.chunkFilenames,
      (idx, { status, transcript }) => {
        if (item.chunks[idx]) {
          item.chunks[idx].status = status;
          item.chunks[idx].transcript = transcript;
        }
      },
      (m) => this.logToJob(id, m)
    );
    if (responseCount !== expected) {
      this.logToJob(id, `Warning: batch returned ${responseCount} response(s) for ${expected} chunk(s).`);
    }
    this.logToJob(id, `Batch job succeeded. Parsed ${responseCount} response(s)${empty ? `, ${empty} empty` : ''}.`);

    // 7. Clean up cloud files. The pending record is cleared by runJob once
    //    transcript.txt is safely on disk.
    await this.deleteUploadedFiles(ai, uploadedFiles, (m) => this.logToJob(id, m));
    return full;
  }

  /**
   * On startup / page load, look for batch jobs that were submitted in a
   * previous run and never collected, ask Google for their status, and — for
   * any that have SUCCEEDED — write their transcript.txt and clean up. Still
   * running? We keep polling in the background and leave the pending record so
   * a later run can try again. `apiKey` is supplied by the caller (browser),
   * falling back to the GEMINI_API_KEY env var.
   *
   * Returns quickly: each batch is resumed in the background.
   */
  static async resumePendingBatches(apiKey) {
    const pending = this.listPendingBatches();
    if (pending.length === 0) return { pending: 0, resuming: 0 };

    const key = (apiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!key) {
      console.log(`[Resume] ${pending.length} pending batch(es) found, but no API key available to resume yet.`);
      return { pending: pending.length, resuming: 0, needKey: true };
    }

    global.resumingBatches = global.resumingBatches || new Set();
    const ai = new GoogleGenAI({ apiKey: key });
    let started = 0;
    for (const meta of pending) {
      if (global.resumingBatches.has(meta.batchName)) continue; // already being handled
      global.resumingBatches.add(meta.batchName);
      started++;
      // Fire-and-forget; each resume writes its own transcript when ready.
      this.resumeOneBatch(ai, meta)
        .catch(err => console.error(`[Resume ${meta.batchName}] Failed: ${err.message}`))
        .finally(() => global.resumingBatches.delete(meta.batchName));
    }
    return { pending: pending.length, resuming: started };
  }

  static async resumeOneBatch(ai, meta) {
    const log = (m) => console.log(`[Resume ${meta.batchName}] ${m}`);
    log(`Checking status of batch for "${meta.itemTitle}"...`);
    const batchJob = await this.pollBatch(ai, meta.batchName, log);

    if (!batchJob || batchJob.state !== 'JOB_STATE_SUCCEEDED') {
      // Terminal-but-failed: clean up so we don't retry forever. Still running
      // (non-terminal after the cap): leave the record for the next attempt.
      if (batchJob && BATCH_TERMINAL_STATES.has(batchJob.state)) {
        log(`Batch ended in ${batchJob.state}; clearing pending record.`);
        await this.deleteUploadedFiles(ai, meta.uploadedFiles, log);
        this.deletePendingBatch(meta.id);
      } else {
        log('Batch still not finished; will try again on the next run.');
      }
      return;
    }

    const { full, responseCount } = this.buildBatchTranscript(batchJob, meta.chunkFilenames, null, log);
    await fs.promises.mkdir(path.dirname(meta.transcriptPath), { recursive: true });
    await fs.promises.writeFile(meta.transcriptPath, full, 'utf8');
    log(`Transcript recovered and written to ${meta.transcriptPath} (${responseCount} part(s)).`);

    await this.deleteUploadedFiles(ai, meta.uploadedFiles, log);
    this.deletePendingBatch(meta.id);
    log('Done. Pending batch cleared.');
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
