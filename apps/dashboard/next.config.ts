import type { NextConfig } from 'next';

const apiUrl =
  process.env.CONNECT_API_URL ?? process.env.NEXT_PUBLIC_CONNECT_API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@connect/shared'],
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: `${apiUrl}/api/auth/:path*`,
      },
      {
        source: '/v1/:path*',
        destination: `${apiUrl}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
