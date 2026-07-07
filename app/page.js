'use client';

import { useState, useEffect, useRef } from 'react';

export default function Home() {
  const [source, setSource] = useState('youtube'); // 'youtube' | 'local'
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [stages, setStages] = useState({ split: true, transcribe: true });
  const [chunkDuration, setChunkDuration] = useState('10'); // in minutes
  const [apiKey, setApiKey] = useState('');
  const [fetchingMetadata, setFetchingMetadata] = useState(false);
  const [playlistData, setPlaylistData] = useState(null);
  const [jobId, setJobId] = useState('');
  const [jobStatus, setJobStatus] = useState(null);
  const [selectedVideoId, setSelectedVideoId] = useState(null);
  const [error, setError] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [processing, setProcessing] = useState(false);

  const logsEndRef = useRef(null);

  const inputValue = source === 'youtube' ? playlistUrl : localPath;
  const setInputValue = source === 'youtube' ? setPlaylistUrl : setLocalPath;

  // Load API key from local storage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) setApiKey(savedKey);
  }, []);

  const handleApiKeyChange = (val) => {
    setApiKey(val);
    localStorage.setItem('gemini_api_key', val);
  };

  // Scroll logs terminal to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [jobStatus?.logs]);

  // Polling effect for job status
  useEffect(() => {
    if (!jobId) return;
    let isMounted = true;
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status?jobId=${jobId}`);
        if (!res.ok) throw new Error('Failed to fetch job status');
        const data = await res.json();
        if (isMounted) {
          setJobStatus(data);
          if (data.status === 'completed' || data.status === 'failed') {
            clearInterval(pollInterval);
            setProcessing(false);
          }
        }
      } catch (err) {
        console.error(err);
        if (isMounted) {
          setError(`Polling error: ${err.message}`);
          clearInterval(pollInterval);
          setProcessing(false);
        }
      }
    }, 2000);

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  }, [jobId]);

  const toggleStage = (key) => {
    setStages((s) => ({ ...s, [key]: !s[key] }));
  };

  // Human-readable summary of the selected workflow.
  const workflowSteps = () => {
    const parts = [];
    if (source === 'youtube') parts.push('Download MP3');
    if (stages.split) parts.push('Split into chunks');
    if (stages.transcribe) parts.push('Transcribe');
    return parts;
  };
  const steps = workflowSteps();
  const nothingSelected = steps.length === 0;

  const validate = () => {
    if (!inputValue.trim()) {
      return source === 'youtube'
        ? 'Please enter a YouTube playlist or video URL.'
        : 'Please enter a local file or folder path.';
    }
    if (nothingSelected) {
      return 'Select at least one action (Download / Split / Transcribe).';
    }
    if (stages.transcribe && !apiKey.trim()) {
      return 'A Gemini API key is required to transcribe.';
    }
    return '';
  };

  // Step 1: Preview the input (list videos / local files)
  const handleFetchPlaylist = async (e) => {
    if (e) e.preventDefault();
    if (!inputValue.trim()) {
      setError(source === 'youtube' ? 'Please enter a YouTube URL.' : 'Please enter a local path.');
      return;
    }
    setError('');
    setFetchingMetadata(true);
    setPlaylistData(null);
    try {
      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, input: inputValue, stages }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to retrieve details.');
      }
      const data = await res.json();
      setPlaylistData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setFetchingMetadata(false);
    }
  };

  // Step 2: Start the background job
  const handleStartJob = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setProcessing(true);
    setJobStatus(null);
    setJobId('');
    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          input: inputValue,
          apiKey,
          stages,
          chunkDuration: parseFloat(chunkDuration) * 60, // minutes -> seconds
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to start processing job.');
      }
      const data = await res.json();
      setJobId(data.jobId);
      setSelectedVideoId(null);
    } catch (err) {
      setError(err.message);
      setProcessing(false);
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'initializing': return 'Initializing';
      case 'fetching_metadata': return 'Analyzing Source';
      case 'processing': return 'Processing';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      case 'downloading': return 'Downloading Audio';
      case 'splitting': return 'Splitting Audio';
      case 'transcribing': return 'Transcribing';
      case 'queued': return 'Queued';
      default: return status || 'Unknown';
    }
  };

  const formatSecs = (secs) => {
    if (!secs) return '—';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ---- Friendly, step-by-step progress derivation ----
  const deriveProgress = (status) => {
    const empty = {
      percent: 0,
      stageKey: 'idle',
      headline: 'Waiting to start',
      detail: 'Choose a source, pick your actions, then press Start.',
      steps: [],
    };
    if (!status) return empty;

    const jobSource = status.source || 'youtube';
    const jobStages = status.stages || { split: true, transcribe: true };

    if (status.status === 'initializing' || status.status === 'fetching_metadata') {
      return {
        percent: 3,
        stageKey: 'analyzing',
        headline: jobSource === 'local' ? 'Scanning local files' : 'Analysing the YouTube link',
        detail: jobSource === 'local'
          ? 'Looking for .mp3 files at the path you provided.'
          : 'Asking yt-dlp for the list of videos and their details.',
        steps: [],
      };
    }

    const videos = status.videos || [];
    const total = videos.length;
    if (total === 0) {
      return { ...empty, headline: 'Nothing found', detail: 'No videos or audio files were found.' };
    }

    const videoFraction = (v) => {
      switch (v.status) {
        case 'completed': return 1;
        case 'failed': return 1;
        case 'downloading': return 0.15;
        case 'splitting': return 0.4;
        case 'transcribing': {
          if (!v.chunks || v.chunks.length === 0) return 0.55;
          const done = v.chunks.filter(c => c.status === 'completed').length;
          return 0.55 + (done / v.chunks.length) * 0.45;
        }
        default: return 0;
      }
    };
    const percent = Math.round((videos.reduce((s, v) => s + videoFraction(v), 0) / total) * 100);

    if (status.status === 'completed') {
      const ok = videos.filter(v => v.status === 'completed').length;
      const what = jobStages.transcribe ? 'Transcribed' : jobStages.split ? 'Processed & split' : 'Downloaded';
      return {
        percent: 100,
        stageKey: 'done',
        headline: 'All done 🎉',
        detail: `${what} ${ok} of ${total} item${total === 1 ? '' : 's'}. Files are in the project's output/ folder.` +
          (jobStages.transcribe ? ' Select an item to read or download its transcript.' : ''),
        steps: [],
      };
    }
    if (status.status === 'failed') {
      return {
        percent,
        stageKey: 'failed',
        headline: 'The job stopped with errors',
        detail: 'Check the system log on the left for the exact cause, then fix the input and try again.',
        steps: [],
      };
    }

    const activeIdx = videos.findIndex(v => ['downloading', 'splitting', 'transcribing'].includes(v.status));
    const active = activeIdx >= 0 ? videos[activeIdx] : null;
    const position = active ? `Item ${activeIdx + 1} of ${total}` : `Processing ${total} item(s)`;

    let headline = 'Processing';
    let detail = '';
    let stageKey = 'processing';

    if (active) {
      if (active.status === 'downloading') {
        stageKey = 'download';
        headline = `Downloading audio — ${position}`;
        detail = `Fetching the best-quality audio for "${active.title}" with yt-dlp and converting to MP3.`;
      } else if (active.status === 'splitting') {
        stageKey = 'split';
        headline = `Splitting into chunks — ${position}`;
        detail = `Using ffmpeg to cut "${active.title}" into ${chunkDuration}-minute segments.`;
      } else if (active.status === 'transcribing') {
        stageKey = 'transcribe';
        const done = active.chunks?.filter(c => c.status === 'completed').length || 0;
        const totalChunks = active.chunks?.length || 0;
        headline = `Transcribing — ${position}`;
        detail = `Uploading each chunk to Gemini and turning speech into text. ${done} of ${totalChunks} chunk${totalChunks === 1 ? '' : 's'} done for "${active.title}".`;
      }
    }

    // Per-item checklist limited to the stages this job actually runs.
    const stageDefs = [];
    if (jobSource === 'youtube') stageDefs.push({ key: 'downloading', label: 'Download audio' });
    if (jobStages.split) stageDefs.push({ key: 'splitting', label: 'Split into chunks' });
    if (jobStages.transcribe) stageDefs.push({ key: 'transcribing', label: 'Transcribe with Gemini' });

    const order = ['downloading', 'splitting', 'transcribing', 'completed'];
    const activeRank = active ? order.indexOf(active.status) : -1;
    const checklist = active ? stageDefs.map((s) => {
      const rank = order.indexOf(s.key);
      let state = 'pending';
      if (activeRank > rank) state = 'done';
      else if (activeRank === rank) state = 'active';
      return { ...s, state };
    }) : [];

    return { percent, stageKey, headline, detail, steps: checklist };
  };

  const progress = deriveProgress(jobStatus);
  const completedCount = jobStatus?.videos?.filter(v => v.status === 'completed').length || 0;
  const failedCount = jobStatus?.videos?.filter(v => v.status === 'failed').length || 0;
  const jobDidTranscribe = jobStatus?.stages?.transcribe;

  const selectedVideo = jobStatus?.videos?.find(v => v.id === selectedVideoId) ||
                        playlistData?.videos?.find(v => v.id === selectedVideoId);

  const getSelectedVideoTranscript = () => {
    if (!selectedVideo || !selectedVideo.chunks) return '';
    return selectedVideo.chunks
      .map((c, idx) => `=== PART ${idx + 1} (${c.filename}) ===\n\n${c.transcript || '(Pending transcription...)'}`)
      .join('\n\n');
  };

  const selectedHasTranscript = selectedVideo?.chunks?.some(c => c.transcript);

  const handleDownloadTranscript = (video) => {
    if (!video) return;
    const transcriptText = video.chunks
      ? video.chunks.map((c, idx) => `=== PART ${idx + 1} (${c.filename}) ===\n\n${c.transcript}`).join('\n\n')
      : 'No transcript generated yet.';
    const element = document.createElement('a');
    const file = new Blob([transcriptText], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = `${video.title.replace(/[\\/:*?"<>|]/g, '_')}_transcript.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const busy = processing || fetchingMetadata;

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '40px 20px', minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '30px' }}>

      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '2.5rem', fontWeight: '800', margin: '0' }}>
            <span className="text-gradient">AuraTranscribe</span>
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '5px', fontSize: '1rem' }}>
            Download, split &amp; transcribe audio — from YouTube or your own MP3 files
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '0.87rem', color: 'var(--text-muted)' }}>Local Dev Server Running</span>
          <span className="pulse-dot"></span>
        </div>
      </header>

      <main style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '30px' }}>

        {/* Error Alert */}
        {error && (
          <div style={{ padding: '16px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--error)', borderRadius: '8px', color: 'var(--error)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span style={{ fontWeight: '500' }}>{error}</span>
          </div>
        )}

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '30px' }}>

          {/* Job Inputs Form */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
                Configure Task
              </h2>

              {/* Source selector */}
              <div className="input-group">
                <label className="input-label">Audio Source</label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  {[
                    { key: 'youtube', label: 'YouTube URL' },
                    { key: 'local', label: 'Local MP3 files' },
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => { setSource(opt.key); setPlaylistData(null); }}
                      disabled={busy}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '8px', cursor: busy ? 'not-allowed' : 'pointer',
                        fontWeight: '600', fontSize: '0.9rem',
                        background: source === opt.key ? 'rgba(139, 92, 246, 0.18)' : 'rgba(0,0,0,0.25)',
                        border: `1px solid ${source === opt.key ? 'var(--primary)' : 'var(--border-glass)'}`,
                        color: source === opt.key ? 'var(--text-primary)' : 'var(--text-secondary)',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Input: URL or local path */}
              <div className="input-group">
                <label className="input-label" htmlFor="main-input">
                  {source === 'youtube' ? 'YouTube Video or Playlist URL' : 'Local File or Folder Path'}
                </label>
                <input
                  id="main-input"
                  type="text"
                  className="text-input"
                  placeholder={source === 'youtube'
                    ? 'https://www.youtube.com/playlist?list=...'
                    : 'C:\\Users\\you\\Music\\lecture.mp3  or  a folder of mp3s'}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  disabled={busy}
                />
                {source === 'local' && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Point to a single <code>.mp3</code>, or a folder. With <strong>Split</strong> on, each mp3 is treated as a full recording. With <strong>Transcribe only</strong>, all mp3s in the folder are treated as chunks of one recording.
                  </span>
                )}
              </div>

              {/* Actions / stages */}
              <div className="input-group">
                <label className="input-label">Actions</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {source === 'youtube' && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                      borderRadius: '8px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16,185,129,0.3)',
                      fontSize: '0.9rem', color: 'var(--text-secondary)',
                    }}>
                      <span style={{ color: 'var(--success)', fontWeight: '700' }}>✓</span>
                      <span><strong style={{ color: 'var(--text-primary)' }}>Download MP3</strong> — always on for YouTube</span>
                    </div>
                  )}
                  {[
                    { key: 'split', label: 'Split into chunks', hint: 'Cut audio into segment-sized pieces with ffmpeg' },
                    { key: 'transcribe', label: 'Transcribe with Gemini', hint: 'Turn audio into text (needs an API key)' },
                  ].map(opt => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => toggleStage(opt.key)}
                      disabled={busy}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', textAlign: 'left',
                        borderRadius: '8px', cursor: busy ? 'not-allowed' : 'pointer',
                        background: stages[opt.key] ? 'rgba(139, 92, 246, 0.14)' : 'rgba(0,0,0,0.25)',
                        border: `1px solid ${stages[opt.key] ? 'var(--primary)' : 'var(--border-glass)'}`,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <span style={{
                        width: '20px', height: '20px', borderRadius: '5px', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: '700',
                        background: stages[opt.key] ? 'var(--primary)' : 'transparent',
                        border: stages[opt.key] ? 'none' : '1px solid var(--text-muted)',
                        color: '#fff',
                      }}>
                        {stages[opt.key] ? '✓' : ''}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: '600', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{opt.label}</span>
                        <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{opt.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* API key — only meaningful when transcribing */}
              {stages.transcribe && (
                <div className="input-group">
                  <label className="input-label" htmlFor="api-key">Google Gemini API Key</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="api-key"
                      type={showApiKey ? 'text' : 'password'}
                      className="text-input"
                      placeholder="AIzaSy..."
                      style={{ paddingRight: '45px' }}
                      value={apiKey}
                      onChange={(e) => handleApiKeyChange(e.target.value)}
                      disabled={processing}
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
                    >
                      {showApiKey ? (
                        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                        </svg>
                      ) : (
                        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.43 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Get a free key from Google AI Studio. Stored locally in your browser.</span>
                </div>
              )}

              {/* Chunk size — only meaningful when splitting */}
              {stages.split && (
                <div className="input-group">
                  <label className="input-label" htmlFor="chunk-duration">Chunk Segment Size (Minutes)</label>
                  <input
                    id="chunk-duration"
                    type="number"
                    min="1"
                    max="60"
                    className="text-input"
                    value={chunkDuration}
                    onChange={(e) => setChunkDuration(e.target.value)}
                    disabled={processing}
                  />
                </div>
              )}

              {/* Workflow summary */}
              <div style={{
                background: nothingSelected ? 'rgba(239,68,68,0.08)' : 'rgba(6, 182, 212, 0.06)',
                border: `1px solid ${nothingSelected ? 'var(--error)' : 'var(--border-glass)'}`,
                borderRadius: '8px', padding: '12px 14px', fontSize: '0.85rem',
              }}>
                <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.05em' }}>This job will</span>
                <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
                  {nothingSelected ? (
                    <span style={{ color: 'var(--error)' }}>Nothing selected — pick at least one action.</span>
                  ) : steps.map((s, idx) => (
                    <span key={s} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: '6px', background: 'rgba(139,92,246,0.15)', border: '1px solid var(--border-glass)', fontWeight: '600', color: 'var(--text-primary)' }}>{s}</span>
                      {idx < steps.length - 1 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={handleFetchPlaylist}
                disabled={busy}
              >
                {fetchingMetadata ? (<><span className="loading-spinner"></span> Loading...</>) : 'Preview'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1.5 }}
                onClick={handleStartJob}
                disabled={busy || nothingSelected}
              >
                {processing ? (<><span className="loading-spinner"></span> Running...</>) : 'Start'}
              </button>
            </div>
          </div>

          {/* Job Overview Panel */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Pipeline Status
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div style={{ padding: '12px', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Job State</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', fontWeight: '600' }}>
                  <span className={`pulse-dot ${jobStatus?.status === 'processing' || jobStatus?.status === 'fetching_metadata' ? 'processing' : jobStatus?.status === 'failed' ? 'failed' : jobStatus?.status === 'completed' ? '' : 'queued'}`}></span>
                  {getStatusLabel(jobStatus?.status || 'Idle')}
                </div>
              </div>
              <div style={{ padding: '12px', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Source Title</span>
                <div style={{ marginTop: '4px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={jobStatus?.playlistTitle || playlistData?.title || 'None'}>
                  {jobStatus?.playlistTitle || playlistData?.title || 'None'}
                </div>
              </div>
              <div style={{ padding: '12px', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Total Items</span>
                <div style={{ fontSize: '1.25rem', fontWeight: '700', marginTop: '4px' }}>
                  {jobStatus?.videos?.length || playlistData?.videos?.length || 0}
                </div>
              </div>
              <div style={{ padding: '12px', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Completed</span>
                <div style={{ fontSize: '1.25rem', fontWeight: '700', marginTop: '4px', color: 'var(--success)' }}>
                  {completedCount}
                </div>
              </div>
            </div>

            {jobStatus && jobStatus.videos?.length > 0 && (
              <div style={{ marginTop: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  <span>Overall Progression</span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}

            <div style={{ background: 'rgba(139, 92, 246, 0.05)', border: '1px dashed var(--border-glass-focus)', borderRadius: '8px', padding: '12px', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              <strong style={{ color: 'var(--primary-hover)', display: 'block', marginBottom: '4px' }}>Mix &amp; match:</strong>
              Download only, download + split, or the full download → split → transcribe. Already have MP3s? Point to a local file or folder to just split them, just transcribe them, or both. Everything is saved under the project&apos;s <code>output/</code> directory.
            </div>
          </div>
        </section>

        {/* Video/Item List and Transcription Preview */}
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '30px' }}>

          {/* Item List Panel */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '550px' }}>
            <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Items
            </h2>

            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '5px' }}>
              {!(jobStatus?.videos || playlistData?.videos) ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  Nothing loaded yet. Enter a source and click Preview or Start.
                </div>
              ) : (
                (jobStatus?.videos || playlistData?.videos).map((video, idx) => {
                  const isSelected = video.id === selectedVideoId;
                  return (
                    <div
                      key={video.id}
                      onClick={() => setSelectedVideoId(video.id)}
                      style={{
                        padding: '14px 16px',
                        background: isSelected ? 'rgba(139, 92, 246, 0.12)' : 'rgba(0,0,0,0.2)',
                        border: '1px solid',
                        borderColor: isSelected ? 'var(--primary)' : 'var(--border-glass)',
                        borderRadius: '10px', cursor: 'pointer',
                        display: 'flex', flexDirection: 'column', gap: '6px', transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                        <span style={{ fontWeight: '600', fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: '1.3' }}>
                          {idx + 1}. {video.title}
                        </span>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px' }}>
                          {formatSecs(video.duration)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem' }}>
                          <span className={`pulse-dot ${video.status === 'downloading' || video.status === 'splitting' || video.status === 'transcribing' ? 'processing' : video.status === 'failed' ? 'failed' : video.status === 'completed' ? '' : 'queued'}`}></span>
                          <span style={{ color: video.status === 'completed' ? 'var(--success)' : video.status === 'failed' ? 'var(--error)' : 'var(--text-secondary)' }}>
                            {getStatusLabel(video.status)}
                          </span>
                        </div>
                        {video.chunks && video.chunks.length > 0 ? (
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {jobDidTranscribe
                              ? `${video.chunks.filter(c => c.status === 'completed').length}/${video.chunks.length} parts`
                              : `${video.chunks.length} chunk${video.chunks.length === 1 ? '' : 's'}`}
                          </span>
                        ) : video.chunkCount ? (
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {video.chunkCount} chunk{video.chunkCount === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                      {video.error && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--error)', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          Err: {video.error}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Details / Transcription Panel */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '550px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.493 2.11L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8c0-4.6 3.7-8.3 8.3-8.3 4.6 0 8.3 3.7 8.3 8.3 0 4.6-3.7 8.3-8.3 8.3a8.38 8.38 0 01-3.8-.9L3 21z" />
                </svg>
                Transcription Viewer
              </h2>
              {selectedVideo && selectedHasTranscript && (
                <button
                  onClick={() => handleDownloadTranscript(selectedVideo)}
                  className="btn btn-primary"
                  style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                >
                  Download TXT
                </button>
              )}
            </div>

            {!selectedVideo ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-glass)', borderRadius: '10px', padding: '40px', textAlign: 'center' }}>
                Select an item from the list to view its details and any generated transcript.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '0.95rem', fontWeight: '600', color: 'var(--primary-hover)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedVideo.title}
                </div>

                {selectedVideo.chunks && selectedVideo.chunks.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px' }}>
                    {selectedVideo.chunks.map((chunk, idx) => (
                      <div key={idx} style={{
                        padding: '6px 10px',
                        background: chunk.status === 'completed' ? 'rgba(16, 185, 129, 0.1)' : chunk.status === 'transcribing' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255,255,255,0.03)',
                        border: '1px solid',
                        borderColor: chunk.status === 'completed' ? 'var(--success)' : chunk.status === 'transcribing' ? 'var(--warning)' : 'var(--border-glass)',
                        borderRadius: '6px', fontSize: '0.78rem', whiteSpace: 'nowrap',
                        display: 'flex', alignItems: 'center', gap: '6px',
                      }}>
                        <span className={`pulse-dot ${chunk.status === 'transcribing' ? 'processing' : chunk.status === 'completed' ? '' : 'queued'}`} style={{ width: '6px', height: '6px' }}></span>
                        Part {idx + 1}
                      </div>
                    ))}
                  </div>
                )}

                {jobStatus && !jobDidTranscribe && jobStatus.status === 'completed' ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text-secondary)', border: '1px dashed var(--border-glass)', borderRadius: '10px', padding: '30px', lineHeight: '1.6' }}>
                    Transcription was not part of this job.<br />
                    The audio {selectedVideo.chunks?.length > 1 ? 'chunks are' : 'file is'} saved under the project&apos;s <code>output/{jobStatus.playlistTitle}/</code> folder.
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
                    <label className="input-label" style={{ fontSize: '0.78rem' }}>Combined Transcript Stream</label>
                    <textarea
                      readOnly
                      className="text-input"
                      value={getSelectedVideoTranscript() || 'Transcript will stream here once audio chunks are processed...'}
                      style={{ flex: 1, resize: 'none', fontFamily: 'monospace', fontSize: '0.85rem', lineHeight: '1.5', padding: '12px', background: 'rgba(0,0,0,0.4)' }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Live Progress: raw system logs (LHS) + friendly step-by-step (RHS) */}
        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '30px', alignItems: 'stretch' }} className="progress-split">

          {/* LHS — System Logs Terminal (raw, technical) */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              System Log
              <span style={{ fontSize: '0.72rem', fontWeight: '500', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginLeft: 'auto' }}>
                {jobStatus?.logs?.length || 0} lines
              </span>
            </h2>

            <div style={{
              flex: 1, minHeight: '360px', maxHeight: '460px', background: '#040306',
              border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '16px',
              fontFamily: 'Consolas, monospace', fontSize: '0.82rem', lineHeight: '1.5', color: '#a78bfa',
              overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px',
              boxShadow: 'inset 0 4px 12px rgba(0,0,0,0.8)',
            }}>
              {(!jobStatus?.logs || jobStatus.logs.length === 0) ? (
                <span style={{ color: 'var(--text-muted)' }}>[Terminal ready. Start a task to stream logs...]</span>
              ) : (
                jobStatus.logs.map((log, idx) => (
                  <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log}</div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* RHS — Friendly, human-readable progress */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <h2 style={{ fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              What&apos;s Happening
            </h2>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Overall progress</span>
                <span style={{ fontSize: '1.6rem', fontWeight: '800' }} className="text-gradient">{progress.percent}%</span>
              </div>
              <div className="progress-bar-container" style={{ height: '12px', borderRadius: '6px' }}>
                <div className="progress-bar-fill" style={{
                  width: `${progress.percent}%`, borderRadius: '6px',
                  background: progress.stageKey === 'failed' ? 'var(--error)' : 'linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%)',
                }} />
              </div>
              {jobStatus?.videos?.length > 0 && (
                <div style={{ display: 'flex', gap: '16px', marginTop: '10px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  <span><strong style={{ color: 'var(--success)' }}>{completedCount}</strong> done</span>
                  <span><strong style={{ color: 'var(--error)' }}>{failedCount}</strong> failed</span>
                  <span><strong style={{ color: 'var(--text-secondary)' }}>{jobStatus.videos.length}</strong> total</span>
                </div>
              )}
            </div>

            <div style={{
              background: 'rgba(139, 92, 246, 0.06)', border: '1px solid var(--border-glass)',
              borderLeft: `3px solid ${progress.stageKey === 'failed' ? 'var(--error)' : progress.stageKey === 'done' ? 'var(--success)' : 'var(--primary)'}`,
              borderRadius: '10px', padding: '14px 16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '700', fontSize: '1.02rem' }}>
                {['analyzing', 'processing', 'download', 'split', 'transcribe'].includes(progress.stageKey) && (
                  <span className="loading-spinner" style={{ width: '16px', height: '16px', color: 'var(--primary-hover)' }}></span>
                )}
                {progress.headline}
              </div>
              <p style={{ marginTop: '8px', fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                {progress.detail}
              </p>
            </div>

            {progress.steps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: '700' }}>
                  Steps for the current item
                </span>
                {progress.steps.map((step, idx) => (
                  <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '700',
                      background: step.state === 'done' ? 'var(--success)' : step.state === 'active' ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                      color: step.state === 'pending' ? 'var(--text-muted)' : '#fff',
                      border: step.state === 'pending' ? '1px solid var(--border-glass)' : 'none',
                    }}>
                      {step.state === 'done' ? '✓' : idx + 1}
                    </div>
                    <span style={{
                      fontSize: '0.9rem', fontWeight: step.state === 'active' ? '700' : '500',
                      color: step.state === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)',
                    }}>
                      {step.label}
                    </span>
                    {step.state === 'active' && (
                      <span className="loading-spinner" style={{ width: '14px', height: '14px', color: 'var(--primary-hover)', marginLeft: 'auto' }}></span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 'auto', background: 'rgba(0,0,0,0.2)', border: '1px dashed var(--border-glass)', borderRadius: '10px', padding: '12px 14px', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              <strong style={{ color: 'var(--primary-hover)', display: 'block', marginBottom: '4px' }}>Your selected pipeline:</strong>
              {steps.length === 0 ? (
                <span style={{ color: 'var(--text-muted)' }}>No actions selected yet.</span>
              ) : (
                steps.map((s, idx) => (
                  <span key={s}>
                    <span style={{ color: 'var(--text-muted)' }}>{idx + 1}.</span> {s}
                    {idx < steps.length - 1 ? ' → ' : ''}
                  </span>
                ))
              )}
            </div>
          </div>
        </section>

      </main>

      <footer style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '20px', borderTop: '1px solid var(--border-glass)', paddingTop: '20px' }}>
        AuraTranscribe Local App &copy; {new Date().getFullYear()}. Powered by Google Gemini &amp; yt-dlp.
      </footer>
    </div>
  );
}
