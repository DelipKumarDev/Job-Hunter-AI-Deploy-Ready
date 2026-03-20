import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Job Hunter AI',
    template: '%s | Job Hunter AI',
  },
  description: 'Autonomous AI agent that finds, applies to, and follows up on jobs for you.',
  keywords: ['job search', 'AI', 'automation', 'career', 'job application'],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: process.env.NEXT_PUBLIC_APP_URL,
    siteName: 'Job Hunter AI',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
