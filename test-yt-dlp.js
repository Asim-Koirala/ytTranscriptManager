import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function test() {
  const url = 'https://youtube.com/playlist?list=PLbYn2hpzIrShUpgXkcFBU5Zl6Ubv1ej_W';
  console.log('Testing with --flat-playlist...');
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
      '--flat-playlist',
      url,
    ], { maxBuffer: 15 * 1024 * 1024 });

    console.log('Flat-playlist JSON size (chars):', stdout.length);
    const data = JSON.parse(stdout);
    console.log('Type:', data._type);
    console.log('Title:', data.title);
    console.log('Entries count:', data.entries ? data.entries.length : 0);
    if (data.entries && data.entries.length > 0) {
      console.log('First entry:', JSON.stringify(data.entries[0], null, 2));
    }
  } catch (err) {
    console.error('Flat-playlist error:', err);
  }
}

test();
