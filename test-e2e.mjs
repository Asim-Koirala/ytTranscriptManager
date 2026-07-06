import { JobManager } from './lib/jobManager.js';

const playlistUrl = 'https://youtube.com/playlist?list=PLbYn2hpzIrShXkFsZLZ1bQuf01aYc_CxL&si=DWZsfeCTcrZFeyyT';
const dummyApiKey = 'AIzaSyDummyKeyForTestingOnly_123456';

console.log('Starting E2E Integration Test...');
console.log('Playlist URL:', playlistUrl);

// Create the job
const jobId = JobManager.createJob(playlistUrl, dummyApiKey, {
  chunkDuration: 600 // 10 minutes
});

console.log(`Job created with ID: ${jobId}. Polling status...`);

// Poll the job status every 3 seconds
const timer = setInterval(() => {
  const job = JobManager.getJob(jobId);
  if (!job) {
    console.error('Job not found!');
    clearInterval(timer);
    return;
  }

  console.log(`\n--- [Job Status: ${job.status}] ---`);
  
  // Print latest logs
  if (job.logs && job.logs.length > 0) {
    console.log('Latest log lines:');
    job.logs.slice(-3).forEach(l => console.log(l));
  }

  // Print video states
  if (job.videos && job.videos.length > 0) {
    console.log('Videos:');
    job.videos.forEach(v => {
      console.log(` - "${v.title.slice(0, 40)}...": ${v.status} ${v.error ? '(Error: ' + v.error + ')' : ''}`);
    });
  }

  if (job.status === 'completed' || job.status === 'failed') {
    console.log('\n======================================');
    console.log(`Test Finished! Final Job Status: ${job.status}`);
    console.log('Full Log output:');
    job.logs.forEach(l => console.log(l));
    console.log('======================================');
    
    clearInterval(timer);
    process.exit(job.status === 'completed' ? 0 : 1);
  }
}, 3000);
