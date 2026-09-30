import AudioAssistant from "@/components/AudioAssistant";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <AudioAssistant userId="usr_primary" />
    </main>
  );
}