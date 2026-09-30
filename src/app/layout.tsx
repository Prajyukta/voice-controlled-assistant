export const metadata = {
  title: "Agent Ru Voice Backend",
  description: "Next.js Voice Assistant with Google Calendar and Gmail Integration",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f1f5f9" }}>{children}</body>
    </html>
  );
}