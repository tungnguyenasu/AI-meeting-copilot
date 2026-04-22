/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Raise body size limit so ~30s WebM blobs (~300-600 KB) always fit.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
