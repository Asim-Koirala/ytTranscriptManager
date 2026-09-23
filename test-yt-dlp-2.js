import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function test() {
    const url = 'https://youtube.com/playlist?list=PLbYn2hpzIrShUpgXkcFBU5Zl6Ubv1ej_W';
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

        const data = JSON.parse(stdout);
        console.log('playlist title:', data.title);
        if (data.entries && data.entries.length > 0) {
            console.log('Number of entries:', data.entries.length);
            const entry = data.entries[0];
            console.log('Sample entry Keys:', Object.keys(entry));
            console.log('Sample entry detail:', {
                id: entry.id,
                title: entry.title,
                url: entry.url,
                webpage_url: entry.webpage_url,
                duration: entry.duration,
                type: entry._type
            });
        }
    } catch (err) {
        console.error('Error:', err);
    }
}

test();
