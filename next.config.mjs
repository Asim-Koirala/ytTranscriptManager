/** @type {import('next').NextConfig} */
const nextConfig = {
  // ffmpeg-static / ffprobe-static resolve their binary path at runtime using
  // `path.join(__dirname, ...)`. When Turbopack bundles them into the server
  // chunk it rewrites `__dirname` to a placeholder like "\ROOT", producing a
  // broken path (e.g. "\ROOT\node_modules\ffmpeg-static\ffmpeg.exe") and yt-dlp
  // then fails with "ffprobe and ffmpeg not found". Marking them external keeps
  // native Node `require`, so `__dirname` points at the real package folder.
  serverExternalPackages: ['ffmpeg-static', 'ffprobe-static'],
};

export default nextConfig;
